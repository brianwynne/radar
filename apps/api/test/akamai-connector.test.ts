// AkamaiConnector connected-state gating: only a live S3 source that has polled successfully and
// recently reads as connected. An injected fetch fakes S3 (ListObjectsV2 XML + a gzip log object) so
// the poll path runs end to end; staleness flips it back to not-connected.
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createAkamaiConnector, loadAkamaiConfig } from '../src/akamai/index.js';

const KEY = 'ds/2026/07/16/part-001.json.gz';
const LIST_XML = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
  `<Contents><Key>${KEY}</Key><LastModified>2026-07-16T21:00:00Z</LastModified><Size>10</Size></Contents></ListBucketResult>`;

function fakeS3Fetch(now: () => number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('list-type=2')) return new Response(LIST_XML, { status: 200 });
    const sec = Math.floor(now() / 1000) - 1;
    const body = gzipSync(Buffer.from([
      JSON.stringify({ reqTimeSec: String(sec), cp: '1629049', bytes: '1000', cacheStatus: '1', statusCode: '200' }),
      JSON.stringify({ reqTimeSec: String(sec), cp: '1629049', bytes: '200', cacheStatus: '0', statusCode: '404' }),
    ].join('\n') + '\n'));
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

function connector(clock: { ms: number }) {
  const cfg = loadAkamaiConfig({
    AKAMAI_ENABLED: 'true', AKAMAI_CP_CODES: '1629049', AKAMAI_CP_NAMES: '1629049=LIVE.RTE.IE', AKAMAI_WINDOW_SECONDS: '300',
    AKAMAI_S3_BUCKET: 'rte-ds2', AKAMAI_S3_REGION: 'eu-west-1', AKAMAI_S3_ACCESS_KEY_ID: 'AKID', AKAMAI_S3_SECRET_KEY: 'secret', AKAMAI_S3_POLL_INTERVAL_SECONDS: '30',
  });
  return createAkamaiConnector(cfg, { now: () => clock.ms, fetchImpl: fakeS3Fetch(() => clock.ms) });
}

describe('AkamaiConnector connected gating', () => {
  it('is not connected before a successful S3 poll, connected after, serving telemetry', async () => {
    const clock = { ms: 1_700_000_000_000 };
    const c = connector(clock);
    expect(c.connected()).toBe(false); // no poll yet
    expect(c.snapshot().source).toBe('disabled');

    const r = await c.pollOnce();
    expect(r).toMatchObject({ ok: true, objects: 1, records: 2 });

    expect(c.connected()).toBe(true);
    const snap = c.snapshot();
    expect(snap.source).toBe('akamai');
    expect(snap.series[0].serviceName).toBe('LIVE.RTE.IE');
    expect(snap.series[0].samples.at(-1)?.statusCodes).toEqual({ '200': 1, '404': 1 });
    expect(c.status().connected).toBe(true);
  });

  it('goes not-connected again when the last successful poll is stale', async () => {
    const clock = { ms: 1_700_000_000_000 };
    const c = connector(clock);
    await c.pollOnce();
    expect(c.connected()).toBe(true);
    clock.ms += 10 * 60 * 1000; // 10 min later — beyond max(window=300s, interval*3=90s)
    expect(c.connected()).toBe(false);
    expect(c.snapshot().source).toBe('disabled');
  });
});

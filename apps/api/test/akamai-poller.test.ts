// Akamai S3 poller: with a fake S3 client returning canned DS2 log objects, verify it lists, downloads,
// decodes (gzip), parses, and feeds the aggregator — ingesting by RECENCY (object LastModified) and
// deduping already-ingested objects, so newer objects are never skipped because of key ordering.
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { AkamaiAggregator } from '../src/akamai/aggregator.js';
import { AkamaiS3Poller } from '../src/akamai/poller.js';
import type { S3ReadClient, S3Object } from '../src/akamai/s3-client.js';

const gz = (recs: object[]): Buffer => gzipSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join('\n') + '\n'));

class FakeS3 {
  readonly listCalls = 0;
  readonly gotKeys: string[] = [];
  constructor(private readonly objects: S3Object[], private readonly content: Record<string, Buffer>) {}
  async listObjects() {
    return { objects: this.objects, nextToken: null as string | null };
  }
  async getObject(key: string): Promise<Buffer> {
    this.gotKeys.push(key);
    return this.content[key];
  }
}

describe('AkamaiS3Poller', () => {
  it('ingests recently-modified objects regardless of key order, and never re-downloads them', async () => {
    // The second object has a LATER LastModified but a LOWER key (ak-000021 < ak-009830) — the old
    // "start-after the greatest key" scheme would have silently skipped it. Recency-based ingest must not.
    const objects: S3Object[] = [
      { key: 'logs/2026-07-16/stream-117517/1/ak-009830-503-a.json.gz', lastModified: new Date(2_000_000).toISOString(), size: 1 },
      { key: 'logs/2026-07-16/stream-117517/1/ak-000021-614-b.json.gz', lastModified: new Date(2_001_000).toISOString(), size: 1 },
    ];
    const content = {
      [objects[0].key]: gz([
        { reqTimeSec: '2000', cp: '1629049', bytes: '1000', cacheStatus: '1', statusCode: '200' },
        { reqTimeSec: '2000', cp: '1629049', bytes: '500', cacheStatus: '0', statusCode: '404' },
      ]),
      [objects[1].key]: gz([
        { reqTimeSec: '2001', cp: '1629049', bytes: '2000', cacheStatus: '1', statusCode: '200' },
      ]),
    };
    const fake = new FakeS3(objects, content);
    const aggregator = new AkamaiAggregator({ cpCodes: ['1629049'], names: { '1629049': 'LIVE.RTE.IE' }, windowSeconds: 300, source: 'akamai' }, { now: () => 2_001_500 });
    const poller = new AkamaiS3Poller({ s3: fake as unknown as S3ReadClient, aggregator, prefix: 'logs/', intervalMs: 30_000, enabled: true, now: () => 2_001_500 });

    const r1 = await poller.runOnce();
    expect(r1).toMatchObject({ ok: true, objects: 2, records: 3 });
    expect(fake.gotKeys).toHaveLength(2);

    const snap = aggregator.snapshot();
    expect(snap.series[0].serviceName).toBe('LIVE.RTE.IE');
    expect(snap.series[0].samples.map((s) => s.second)).toEqual([2000, 2001]);
    expect(snap.series[0].samples[0].statusCodes).toEqual({ '200': 1, '404': 1 });

    // Second poll: both objects already ingested (seen-map) ⇒ nothing re-downloaded.
    const r2 = await poller.runOnce();
    expect(r2).toMatchObject({ ok: true, objects: 0 });
    expect(fake.gotKeys).toHaveLength(2); // unchanged
  });

  it('skips objects older than the fresh window (backlog / pre-switch logs)', async () => {
    const objects: S3Object[] = [
      { key: 'logs/old/ak-1-1-a.json.gz', lastModified: new Date(1_000_000).toISOString(), size: 1 }, // ~17 min old ⇒ stale
      { key: 'logs/new/ak-2-2-b.json.gz', lastModified: new Date(2_001_000).toISOString(), size: 1 }, // fresh
    ];
    const content = {
      [objects[0].key]: gz([{ reqTimeSec: '900', cp: '1629049', bytes: '1', cacheStatus: '1', statusCode: '200' }]),
      [objects[1].key]: gz([{ reqTimeSec: '2001', cp: '1629049', bytes: '2000', cacheStatus: '1', statusCode: '200' }]),
    };
    const fake = new FakeS3(objects, content);
    const aggregator = new AkamaiAggregator({ cpCodes: [], names: {}, windowSeconds: 300, source: 'akamai' }, { now: () => 2_001_500 });
    const poller = new AkamaiS3Poller({ s3: fake as unknown as S3ReadClient, aggregator, prefix: '', intervalMs: 30_000, enabled: true, now: () => 2_001_500 });

    const r = await poller.runOnce();
    expect(r).toMatchObject({ ok: true, objects: 1, records: 1 }); // only the fresh object
    expect(fake.gotKeys).toEqual([objects[1].key]);
  });

  it('surfaces a failure without throwing and keeps the buffer', async () => {
    const aggregator = new AkamaiAggregator({ cpCodes: [], names: {}, windowSeconds: 300, source: 'akamai' });
    const failing = { listObjects: async () => { throw new Error('s3 down'); }, getObject: async () => Buffer.alloc(0) };
    const poller = new AkamaiS3Poller({ s3: failing as unknown as S3ReadClient, aggregator, prefix: '', intervalMs: 30_000, enabled: true });
    const r = await poller.runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('s3 down');
    expect(poller.status().consecutiveFailures).toBe(1);
  });
});

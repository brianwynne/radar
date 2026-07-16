// Akamai S3 poller: with a fake S3 client returning canned DS2 log objects, verify it lists, downloads,
// decodes (gzip), parses, and feeds the aggregator — and that it advances past already-processed keys.
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { AkamaiAggregator } from '../src/akamai/aggregator.js';
import { AkamaiS3Poller } from '../src/akamai/poller.js';
import type { S3ReadClient, S3Object } from '../src/akamai/s3-client.js';

const gz = (recs: object[]): Buffer => gzipSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join('\n') + '\n'));

class FakeS3 {
  readonly listOpts: Array<{ startAfter?: string; continuationToken?: string }> = [];
  readonly gotKeys: string[] = [];
  constructor(private readonly objects: S3Object[], private readonly content: Record<string, Buffer>) {}
  async listObjects(_prefix: string, opts: { startAfter?: string; continuationToken?: string } = {}) {
    this.listOpts.push(opts);
    const after = opts.startAfter;
    const objects = after ? this.objects.filter((o) => o.key > after) : this.objects;
    return { objects, nextToken: null as string | null };
  }
  async getObject(key: string): Promise<Buffer> {
    this.gotKeys.push(key);
    return this.content[key];
  }
}

describe('AkamaiS3Poller', () => {
  it('processes new objects into the aggregator and advances past processed keys', async () => {
    const objects: S3Object[] = [
      { key: 'ds/2026/07/16/21/00-a.json.gz', lastModified: '', size: 1 },
      { key: 'ds/2026/07/16/21/00-b.json.gz', lastModified: '', size: 1 },
    ];
    const content = {
      'ds/2026/07/16/21/00-a.json.gz': gz([
        { reqTimeSec: '2000', cp: '1629049', bytes: '1000', cacheStatus: '1', statusCode: '200' },
        { reqTimeSec: '2000', cp: '1629049', bytes: '500', cacheStatus: '0', statusCode: '404' },
      ]),
      'ds/2026/07/16/21/00-b.json.gz': gz([
        { reqTimeSec: '2001', cp: '1629049', bytes: '2000', cacheStatus: '1', statusCode: '200' },
      ]),
    };
    const fake = new FakeS3(objects, content);
    const aggregator = new AkamaiAggregator({ cpCodes: ['1629049'], names: { '1629049': 'LIVE.RTE.IE' }, windowSeconds: 300, source: 'akamai' }, { now: () => 2_001_500 });
    const poller = new AkamaiS3Poller({ s3: fake as unknown as S3ReadClient, aggregator, prefix: 'ds/', intervalMs: 30_000, enabled: true });

    const r1 = await poller.runOnce();
    expect(r1).toMatchObject({ ok: true, objects: 2, records: 3 });
    expect(fake.gotKeys).toHaveLength(2);

    const snap = aggregator.snapshot();
    expect(snap.series[0].serviceName).toBe('LIVE.RTE.IE');
    expect(snap.series[0].samples.map((s) => s.second)).toEqual([2000, 2001]);
    expect(snap.series[0].samples[0].statusCodes).toEqual({ '200': 1, '404': 1 });

    // Second poll: start-after the greatest key ⇒ nothing new, no re-download.
    const r2 = await poller.runOnce();
    expect(r2).toMatchObject({ ok: true, objects: 0 });
    expect(fake.gotKeys).toHaveLength(2); // unchanged
    expect(fake.listOpts[1].startAfter).toBe('ds/2026/07/16/21/00-b.json.gz');
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

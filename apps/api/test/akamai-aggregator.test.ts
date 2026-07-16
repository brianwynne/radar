// Akamai DataStream 2 parser + aggregator: replay real DS2-format edge-log records (NDJSON, gzip,
// string-valued fields) and assert the per-CP-code per-second aggregation, the observe filter, window
// prune, and the canonical snapshot/status. No network — this fully verifies the RADAR ingest side.
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { parseDataStreamUpload, parseRecords } from '../src/akamai/datastream.js';
import { AkamaiAggregator } from '../src/akamai/aggregator.js';

// DS2 JSON: one request per line, numeric fields as strings, cacheStatus 1=hit/0=miss.
const LINES = [
  { reqTimeSec: '1000', cp: '1629049', bytes: '1000', cacheStatus: '1', statusCode: '200' },
  { reqTimeSec: '1000', cp: '1629049', bytes: '500', cacheStatus: '0', statusCode: '206' },
  { reqTimeSec: '1000', cp: '1629049', bytes: '200', cacheStatus: '1', statusCode: '404' },
  { reqTimeSec: '1001', cp: '1629049', bytes: '2000', cacheStatus: '1', statusCode: '200' },
  { reqTimeSec: '1001', cp: '1629049', bytes: '100', cacheStatus: '0', statusCode: '0' }, // no response → no class/code
  { reqTimeSec: '1001', cp: '1629053', bytes: '9999', cacheStatus: '1', statusCode: '200' }, // different CP code
];
const ndjson = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n';

function agg(cpCodes: string[]) {
  return new AkamaiAggregator(
    { cpCodes, names: { '1629049': 'LIVE.RTE.IE' }, windowSeconds: 60, source: 'akamai' },
    { now: () => 1_001_500 }, // floor→1001s; cutoff 941 keeps seconds 1000 & 1001
  );
}

describe('DataStream 2 parser', () => {
  it('parses plain NDJSON and decodes gzip identically', () => {
    const plain = parseRecords(ndjson);
    expect(plain).toHaveLength(6);
    expect(plain[0]).toEqual({ second: 1000, cp: '1629049', bytes: 1000, hit: true, statusCode: 200 });
    const gz = parseDataStreamUpload(gzipSync(Buffer.from(ndjson)), 'gzip');
    expect(gz).toEqual(plain);
  });

  it('drops malformed and field-less lines', () => {
    expect(parseRecords('not json\n{"cp":"x"}\n{"reqTimeSec":"5","cp":"c","bytes":"1"}\n')).toEqual([
      { second: 5, cp: 'c', bytes: 1, hit: false, statusCode: 0 },
    ]);
  });
});

describe('AkamaiAggregator', () => {
  it('folds records into per-CP-code per-second buckets with class + individual codes', () => {
    const a = agg(['1629049']); // observe only this CP code → 1629053 is skipped
    const accepted = a.ingest(parseRecords(ndjson));
    expect(accepted).toBe(5); // the 1629053 record is filtered out

    const snap = a.snapshot();
    expect(snap.source).toBe('akamai');
    expect(snap.series).toHaveLength(1);
    const s = snap.series[0];
    expect(s.serviceName).toBe('LIVE.RTE.IE');
    expect(s.samples.map((x) => x.second)).toEqual([1000, 1001]);

    const sec1000 = s.samples[0];
    expect(sec1000.requests).toBe(3);
    expect(sec1000.hits).toBe(2); // 200 + 404 were cache hits
    expect(sec1000.miss).toBe(1); // 206 was a miss
    expect(sec1000.bandwidthBytes).toBe(1700);
    expect(sec1000.status2xx).toBe(2); // 200 + 206
    expect(sec1000.status4xx).toBe(1); // 404
    expect(sec1000.statusCodes).toEqual({ '200': 1, '206': 1, '404': 1 });

    const sec1001 = s.samples[1];
    expect(sec1001.requests).toBe(2); // 200 + the status-0 record
    expect(sec1001.status2xx).toBe(1); // status 0 excluded from any class
    expect(sec1001.statusCodes).toEqual({ '200': 1 });

    // Latest second drives the headline metrics.
    expect(s.latestRequestsPerSecond).toBe(2);
    expect(s.latestBandwidthBps).toBe(2100 * 8);
    expect(snap.provenance.informationalOnly).toBe(true);
  });

  it('observes every CP code when none configured', () => {
    const a = new AkamaiAggregator({ cpCodes: [], names: {}, windowSeconds: 60, source: 'akamai' }, { now: () => 1_001_500 });
    a.ingest(parseRecords(ndjson));
    expect(a.snapshot().series.map((x) => x.serviceId).sort()).toEqual(['1629049', '1629053']);
  });

  it('prunes samples outside the retention window', () => {
    const a = new AkamaiAggregator({ cpCodes: ['c'], names: {}, windowSeconds: 10, source: 'akamai' }, { now: () => 1_000_000 }); // 1000s
    a.ingest([{ second: 980, cp: 'c', bytes: 1, hit: true, statusCode: 200 }]); // 980 < cutoff 990 → pruned
    a.ingest([{ second: 995, cp: 'c', bytes: 1, hit: true, statusCode: 200 }]); // kept
    expect(a.snapshot().series[0].samples.map((x) => x.second)).toEqual([995]);
  });

  it('reports status: records ingested, freshness, and configured services', () => {
    const a = agg(['1629049', '1629053']);
    a.ingest(parseRecords(ndjson));
    const st = a.status();
    expect(st.enabled).toBe(true);
    expect(st.recordsIngested).toBe(6);
    expect(st.services.map((x) => x.serviceId).sort()).toEqual(['1629049', '1629053']);
    expect(st.ingestAgeSeconds).toBeGreaterThanOrEqual(0);
  });
});

// Cache/origin telemetry: config, pure classification (headroom, CPU thresholds, hit-ratio
// validation), mock/disabled/prometheus clients, caching, and credential safety. READ-ONLY
// and INFORMATIONAL — asserts no write path and no steering mutation.
import { describe, it, expect } from 'vitest';
import {
  loadCacheTelemetryConfig,
  createCacheTelemetryClient,
  CachingCacheTelemetryClient,
  MockCacheTelemetryClient,
  DisabledCacheTelemetryClient,
  PrometheusCacheTelemetryClient,
  buildPoolSample,
  headroom,
} from '../src/telemetry/cache-index.js';
import { resolveNodeMappings, resolveOriginMapping, resolvePoolMappings } from '../src/telemetry/pools.js';
import type { CacheTelemetryClient } from '../src/telemetry/cache-types.js';

const POOLS = resolvePoolMappings();
const NODES = resolveNodeMappings();
const ORIGIN = resolveOriginMapping();
const donny = POOLS.find((p) => p.id === 'donnybrook-1')!;
const NOW = Date.parse('2026-07-12T12:00:00Z');

function recordingFetch(handler: (url: string, call: number) => Response | Error) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const out = handler(String(input), calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const vec = (v: number, atSec = NOW / 1000) => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [atSec, String(v)] }] } });

const QUERIES = {
  poolThroughput: 'pool_out{pool="$POOL"}',
  poolCpu: 'pool_cpu{pool="$POOL"}',
  poolHitRatio: 'pool_hit{pool="$POOL"}',
  nodeThroughput: 'node_out{node="$NODE"}',
  nodeCpu: 'node_cpu{node="$NODE"}',
  originCpu: 'origin_cpu',
  originRequestRate: 'origin_req',
  originBandwidth: 'origin_bw',
};
const promClient = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof PrometheusCacheTelemetryClient>[0]> = {}) =>
  new PrometheusCacheTelemetryClient({
    baseUrl: 'https://prom.example.com', auth: { kind: 'none' }, timeoutMs: 500, maxRetries: 2,
    queries: QUERIES, pools: POOLS, nodes: NODES, origin: ORIGIN, staleAfterSeconds: 120, now: () => NOW,
    fetchImpl, sleep: async () => undefined, random: () => 0, ...over,
  });

describe('loadCacheTelemetryConfig', () => {
  it('defaults to disabled', () => {
    expect(loadCacheTelemetryConfig({}).mode).toBe('disabled');
  });
  it('prometheus requires base URL and at least a pool-throughput query', () => {
    expect(() => loadCacheTelemetryConfig({ CACHE_TELEMETRY_MODE: 'prometheus' })).toThrow(/PROMETHEUS_BASE_URL/);
    expect(() => loadCacheTelemetryConfig({ CACHE_TELEMETRY_MODE: 'prometheus', PROMETHEUS_BASE_URL: 'https://p' })).toThrow(/POOL_THROUGHPUT/);
  });
  it('prometheus requires HTTPS outside development and enforces threshold order', () => {
    expect(() => loadCacheTelemetryConfig({ NODE_ENV: 'production', CACHE_TELEMETRY_MODE: 'prometheus', PROMETHEUS_BASE_URL: 'http://p', PROMETHEUS_QUERY_POOL_THROUGHPUT: 'q' })).toThrow(/HTTPS/);
    expect(() => loadCacheTelemetryConfig({ CACHE_TELEMETRY_WARNING_PERCENT: '85', CACHE_TELEMETRY_CRITICAL_PERCENT: '80' })).toThrow(/must be ≥/);
  });
});

describe('headroom & classification (pure)', () => {
  it('computes headroom deterministically and refuses it when capacity/throughput is unavailable', () => {
    expect(headroom(160e9, 80e9)).toBe(80e9);
    expect(headroom(160e9, null)).toBeNull(); // throughput unavailable
    expect(headroom(0, 80e9)).toBeNull(); // zero/invalid capacity
  });
  it('classifies by the worst of throughput and CPU (CPU threshold classification)', () => {
    // Low throughput but critical CPU → critical overall.
    const s = buildPoolSample(donny, { outboundBps: donny.configuredCapacityBps * 0.2, cpuUtilisationPercent: 95, memoryUtilisationPercent: 50, cacheHitRatio: 0.9, requestRate: 1000, observedAt: new Date(NOW) }, { now: NOW, staleAfterSeconds: 120, source: 'mock', synthetic: true });
    expect(s.status).toBe('critical');
    expect(s.observedUtilisationPercent).toBeCloseTo(20, 5);
  });
  it('drops an out-of-range cache hit ratio with a warning', () => {
    const s = buildPoolSample(donny, { outboundBps: 10e9, cpuUtilisationPercent: 40, memoryUtilisationPercent: 40, cacheHitRatio: 1.4, requestRate: 100, observedAt: new Date(NOW) }, { now: NOW, staleAfterSeconds: 120, source: 'mock', synthetic: true });
    expect(s.cacheHitRatio).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/hit ratio out of range/i);
  });
  it('marks a stale observation and never invents a value for unavailable', () => {
    const stale = buildPoolSample(donny, { outboundBps: 10e9, cpuUtilisationPercent: 40, memoryUtilisationPercent: 40, cacheHitRatio: 0.9, requestRate: 100, observedAt: new Date(NOW - 300_000) }, { now: NOW, staleAfterSeconds: 120, source: 'mock', synthetic: true });
    expect(stale.status).toBe('stale');
    const unavailable = buildPoolSample(donny, null, { now: NOW, staleAfterSeconds: 120, source: 'mock', synthetic: true });
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.headroomBps).toBeNull();
  });
});

describe('MockCacheTelemetryClient', () => {
  it('returns deterministic synthetic pools/nodes/origin spanning the status range', async () => {
    const c = new MockCacheTelemetryClient({ pools: POOLS, nodes: NODES, origin: ORIGIN, staleAfterSeconds: 120, now: () => NOW });
    const pools = await c.getCachePools();
    expect(pools.find((p) => p.poolId === 'donnybrook-1')!.status).toBe('healthy');
    expect(pools.find((p) => p.poolId === 'external-2')!.status).toBe('critical');
    expect(pools.every((p) => p.provenance.synthetic)).toBe(true);
    expect((await c.getCacheNodes()).length).toBe(NODES.length);
    expect((await c.getOrigin()).status).not.toBe('telemetry_not_connected');
    expect((await c.getCachePool('external-1'))!.headroomBps).toBeGreaterThan(0);
  });
  it('models stale and unavailable scenarios', async () => {
    const c = new MockCacheTelemetryClient({ pools: POOLS, nodes: NODES, origin: ORIGIN, staleAfterSeconds: 120, now: () => NOW, stalePoolIds: ['donnybrook-2'], unavailablePoolIds: ['external-1'], origin_: 'unavailable' });
    expect((await c.getCachePool('donnybrook-2'))!.status).toBe('stale');
    expect((await c.getCachePool('external-1'))!.status).toBe('unavailable');
    expect((await c.getOrigin()).status).toBe('unavailable');
  });
});

describe('DisabledCacheTelemetryClient', () => {
  it('reports telemetry_not_connected with configured values still exposed', async () => {
    const c = new DisabledCacheTelemetryClient(POOLS, NODES, ORIGIN, 120);
    const pools = await c.getCachePools();
    expect(pools.every((p) => p.status === 'telemetry_not_connected')).toBe(true);
    expect(pools.every((p) => p.observedOutboundBps === null && p.headroomBps === null)).toBe(true);
    expect(pools.every((p) => p.configuredCapacityBps > 0 && p.cacheNodeCount > 0)).toBe(true);
    expect((await c.getOrigin()).status).toBe('telemetry_not_connected');
  });
});

describe('PrometheusCacheTelemetryClient', () => {
  it('parses per-metric instant queries into a classified pool sample', async () => {
    const { fn } = recordingFetch((url) => {
      if (url.includes('pool_out')) return ok(vec(80e9)); // 80 of 160 Gbps = 50%
      if (url.includes('pool_cpu')) return ok(vec(55));
      if (url.includes('pool_hit')) return ok(vec(0.95));
      return ok(vec(0));
    });
    const pool = await promClient(fn).getCachePool('donnybrook-1');
    expect(pool?.observedUtilisationPercent).toBeCloseTo(50, 5);
    expect(pool?.cpuUtilisationPercent).toBe(55);
    expect(pool?.cacheHitRatio).toBe(0.95);
    expect(pool?.headroomBps).toBe(80e9);
    expect(pool?.status).toBe('healthy');
    expect(pool?.source).toBe('prometheus');
  });
  it('is unavailable when the anchor throughput query has no data', async () => {
    const { fn } = recordingFetch(() => ok({ status: 'success', data: { resultType: 'vector', result: [] } }));
    expect((await promClient(fn).getCachePool('donnybrook-1'))?.status).toBe('unavailable');
  });
  it('maps a timeout to unavailable after bounded retries', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { fn } = recordingFetch(() => timeout);
    expect((await promClient(fn).getCachePool('donnybrook-1'))?.status).toBe('unavailable');
  });
  it('reads origin CPU and never leaks the bearer token', async () => {
    const seen: Record<string, string>[] = [];
    const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return ok(vec(String(url).includes('origin_cpu') ? 62 : 9000));
    }) as unknown as typeof fetch;
    const origin = await promClient(fn, { auth: { kind: 'bearer', bearerToken: 'super-secret' } }).getOrigin();
    expect(origin.cpuUtilisationPercent).toBe(62);
    expect(seen[0].Authorization).toBe('Bearer super-secret');
    expect(JSON.stringify(origin)).not.toContain('super-secret');
  });
});

describe('CachingCacheTelemetryClient + read-only guarantees', () => {
  it('serves pools from cache within TTL and refreshes after expiry', async () => {
    let count = 0;
    let now = NOW;
    const inner: CacheTelemetryClient = {
      async getCachePools() { count += 1; return []; },
      async getCachePool() { return null; },
      async getCacheNodes() { return []; },
      async getCacheNode() { return null; },
      async getOrigin() { return { originId: 'o', originName: 'o', requestRate: null, outboundBandwidthBps: null, cpuUtilisationPercent: null, status: 'unavailable', stale: false, freshness: { ageSeconds: null, staleAfterSeconds: 120, fresh: false }, observedAt: null, source: 'mock', warnings: [], provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: '' } }; },
    };
    const cached = new CachingCacheTelemetryClient(inner, 10, () => now);
    await cached.getCachePools();
    await cached.getCachePools();
    expect(count).toBe(1);
    now += 11_000;
    await cached.getCachePools();
    expect(count).toBe(2);
  });
  it('builds the disabled client by default and exposes only read methods (no NS1/Cloudflare write, no steering mutation)', async () => {
    const client = createCacheTelemetryClient(loadCacheTelemetryConfig({}));
    expect((await client.getCachePools()).every((p) => p.status === 'telemetry_not_connected')).toBe(true);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((m) => m !== 'constructor');
    expect(methods).toEqual(expect.arrayContaining(['getCachePools', 'getCacheNodes', 'getOrigin']));
    expect(methods.some((m) => /set|create|update|delete|write|put|patch|mutate|post|steer/i.test(m))).toBe(false);
  });
});

// Network-path telemetry: config, pure classification, mock/disabled/prometheus clients,
// caching, and credential safety. Telemetry is READ-ONLY and INFORMATIONAL — these tests
// also assert it can never write to NS1 or change steering state.
import { describe, it, expect } from 'vitest';
import {
  loadTelemetryConfig,
  createTelemetryClient,
  CachingTelemetryClient,
  MockNetworkPathTelemetryClient,
  DisabledNetworkPathTelemetryClient,
  PrometheusNetworkPathTelemetryClient,
  resolveMappings,
  utilisationPercent,
  classifyUtilisation,
  buildSample,
  TelemetryError,
} from '../src/telemetry/index.js';
import type { NetworkPathTelemetryClient, PathMapping } from '../src/telemetry/types.js';

const MAPPINGS = resolveMappings();
const eir = MAPPINGS.find((m) => m.id === 'eir-pni')!;
const NOW = Date.parse('2026-07-11T12:00:00Z');

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
const vector = (bps: number, atSec = NOW / 1000) => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: { ifName: 'x' }, value: [atSec, String(bps)] }] } });

const prom = (over: Partial<ConstructorParameters<typeof PrometheusNetworkPathTelemetryClient>[0]> = {}, fetchImpl?: typeof fetch) =>
  new PrometheusNetworkPathTelemetryClient({
    baseUrl: 'https://prom.example.com',
    queryTemplate: 'rate(if_$DIRECTION_octets{if="$INTERFACE"}[5m])*8',
    auth: { kind: 'none' },
    timeoutMs: 500,
    maxRetries: 2,
    mappings: MAPPINGS,
    staleAfterSeconds: 120,
    now: () => NOW,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
    ...over,
  });

describe('loadTelemetryConfig', () => {
  it('defaults to disabled', () => {
    const c = loadTelemetryConfig({});
    expect(c.mode).toBe('disabled');
    expect(c.prometheus).toBeUndefined();
  });
  it('prometheus mode requires a base URL and query', () => {
    expect(() => loadTelemetryConfig({ NETWORK_TELEMETRY_MODE: 'prometheus' })).toThrow(/PROMETHEUS_BASE_URL/);
    expect(() => loadTelemetryConfig({ NETWORK_TELEMETRY_MODE: 'prometheus', PROMETHEUS_BASE_URL: 'https://p' })).toThrow(/PROMETHEUS_QUERY_PATH_UTILISATION/);
  });
  it('prometheus requires HTTPS outside development', () => {
    expect(() => loadTelemetryConfig({ NODE_ENV: 'production', NETWORK_TELEMETRY_MODE: 'prometheus', PROMETHEUS_BASE_URL: 'http://p', PROMETHEUS_QUERY_PATH_UTILISATION: 'q' })).toThrow(/HTTPS/);
    expect(loadTelemetryConfig({ NODE_ENV: 'development', NETWORK_TELEMETRY_MODE: 'prometheus', PROMETHEUS_BASE_URL: 'http://p', PROMETHEUS_QUERY_PATH_UTILISATION: 'q' }).mode).toBe('prometheus');
  });
  it('rejects critical < warning', () => {
    expect(() => loadTelemetryConfig({ NETWORK_TELEMETRY_WARNING_PERCENT: '85', NETWORK_TELEMETRY_CRITICAL_PERCENT: '80' })).toThrow(/must be ≥/);
  });
});

describe('utilisation & classification (pure)', () => {
  it('computes utilisation and refuses invalid capacity/rate (never divides by zero)', () => {
    expect(utilisationPercent(50e9, 100e9)).toBe(50);
    expect(utilisationPercent(null, 100e9)).toBeNull();
    expect(utilisationPercent(50e9, 0)).toBeNull(); // zero capacity
    expect(utilisationPercent(50e9, -1)).toBeNull(); // invalid capacity
    expect(utilisationPercent(-5, 100e9)).toBeNull(); // invalid rate
  });
  it('classifies against target/warning/critical thresholds', () => {
    const t = { configuredTargetPercent: 70, warningThresholdPercent: 80, criticalThresholdPercent: 90 };
    expect(classifyUtilisation(55, t)).toBe('healthy');
    expect(classifyUtilisation(75, t)).toBe('above_target');
    expect(classifyUtilisation(84, t)).toBe('warning');
    expect(classifyUtilisation(94, t)).toBe('critical');
  });
  it('flags a stale observation and never invents a value for unavailable', () => {
    const staleObs = { inboundBps: 1e9, outboundBps: 50e9, observedAt: new Date(NOW - 300_000) };
    const stale = buildSample(eir, staleObs, { now: NOW, staleAfterSeconds: 120, source: 'mock', synthetic: true });
    expect(stale.status).toBe('stale');
    expect(stale.stale).toBe(true);

    const missing: PathMapping = { ...eir, configuredCapacityBps: 0 };
    const s = buildSample(missing, { inboundBps: 1e9, outboundBps: 50e9, observedAt: new Date(NOW) }, { now: NOW, staleAfterSeconds: 120, source: 'mock', synthetic: true });
    expect(s.status).toBe('unavailable');
    expect(s.observedUtilisationPercent).toBeNull();
  });
});

describe('MockNetworkPathTelemetryClient', () => {
  it('returns deterministic synthetic samples for every configured path', async () => {
    const c = new MockNetworkPathTelemetryClient({ mappings: MAPPINGS, staleAfterSeconds: 120, now: () => NOW });
    const paths = await c.getNetworkPaths();
    expect(paths.map((p) => p.pathId).sort()).toEqual(['eir-pni', 'inex', 'transit', 'virgin-liberty-pni']);
    const eirSample = paths.find((p) => p.pathId === 'eir-pni')!;
    expect(eirSample.status).toBe('healthy');
    expect(eirSample.provenance.synthetic).toBe(true);
    expect(eirSample.source).toBe('mock');
    expect(paths.find((p) => p.pathId === 'transit')!.status).toBe('critical');
  });
  it('can model stale and unavailable scenarios', async () => {
    const c = new MockNetworkPathTelemetryClient({ mappings: MAPPINGS, staleAfterSeconds: 120, now: () => NOW, stalePathIds: ['inex'], unavailablePathIds: ['transit'] });
    const paths = await c.getNetworkPaths();
    expect(paths.find((p) => p.pathId === 'inex')!.status).toBe('stale');
    expect(paths.find((p) => p.pathId === 'transit')!.status).toBe('unavailable');
  });
});

describe('DisabledNetworkPathTelemetryClient', () => {
  it('reports telemetry_not_connected for every path with no observed value', async () => {
    const c = new DisabledNetworkPathTelemetryClient(MAPPINGS, 120);
    const paths = await c.getNetworkPaths();
    expect(paths).toHaveLength(4);
    expect(paths.every((p) => p.status === 'telemetry_not_connected')).toBe(true);
    expect(paths.every((p) => p.observedUtilisationPercent === null)).toBe(true);
    expect(paths.every((p) => p.configuredCapacityBps > 0)).toBe(true); // configured values still exposed
  });
});

describe('PrometheusNetworkPathTelemetryClient', () => {
  it('parses an instant-query response into an observed utilisation', async () => {
    // Outbound queries return 52 Gb/s; inbound 18 Gb/s. Eir capacity 100 Gb/s → 52%.
    const { fn } = recordingFetch((url) => ok(vector(url.includes('if_out') ? 52e9 : 18e9)));
    const eirSample = await prom({}, fn).getNetworkPath('eir-pni');
    expect(eirSample?.observedUtilisationPercent).toBeCloseTo(52, 5);
    expect(eirSample?.observedOutboundBps).toBe(52e9);
    expect(eirSample?.observedInboundBps).toBe(18e9);
    expect(eirSample?.status).toBe('healthy');
    expect(eirSample?.source).toBe('prometheus');
  });
  it('maps an invalid response to unavailable (never throws out, never invents a value)', async () => {
    const { fn } = recordingFetch(() => ok({ status: 'success', data: { resultType: 'vector', result: [{ value: [1, 'not-a-number'] }] } }));
    const s = await prom({}, fn).getNetworkPath('eir-pni');
    expect(s?.status).toBe('unavailable');
    expect(s?.observedUtilisationPercent).toBeNull();
  });
  it('treats no series as unavailable', async () => {
    const { fn } = recordingFetch(() => ok({ status: 'success', data: { resultType: 'vector', result: [] } }));
    expect((await prom({}, fn).getNetworkPath('eir-pni'))?.status).toBe('unavailable');
  });
  it('maps a timeout to unavailable after bounded retries', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const { fn, calls } = recordingFetch(() => timeout);
    const s = await prom({ maxRetries: 2 }, fn).getNetworkPath('eir-pni');
    expect(s?.status).toBe('unavailable');
    expect(calls.length).toBe(3); // 1 + 2 retries on the primary query
  });
  it('sends generic auth and never leaks the token in the sample or errors', async () => {
    const seen: Record<string, string>[] = [];
    const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return ok(vector(52e9));
    }) as unknown as typeof fetch;
    const client = prom({ auth: { kind: 'bearer', bearerToken: 'super-secret-token' } }, fn);
    const s = await client.getNetworkPath('eir-pni');
    expect(seen[0].Authorization).toBe('Bearer super-secret-token'); // sent upstream…
    expect(JSON.stringify(s)).not.toContain('super-secret-token'); // …never returned to callers
  });
});

describe('CachingTelemetryClient', () => {
  it('serves from cache within TTL and refreshes after expiry', async () => {
    let count = 0;
    let now = NOW;
    const inner: NetworkPathTelemetryClient = {
      async getNetworkPaths() { count += 1; return []; },
      async getNetworkPath() { return null; },
    };
    const cached = new CachingTelemetryClient(inner, 10, () => now);
    await cached.getNetworkPaths();
    await cached.getNetworkPaths();
    expect(count).toBe(1); // second call hit the cache
    now += 11_000; // past the 10s TTL
    await cached.getNetworkPaths();
    expect(count).toBe(2);
  });
});

describe('createTelemetryClient + read-only guarantees', () => {
  it('builds the disabled client by default and exposes only read methods', async () => {
    const client = createTelemetryClient(loadTelemetryConfig({}));
    const paths = await client.getNetworkPaths();
    expect(paths.every((p) => p.status === 'telemetry_not_connected')).toBe(true);
    // The contract has no write/mutate method — telemetry can never change NS1 or state.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((m) => m !== 'constructor');
    expect(methods).toEqual(expect.arrayContaining(['getNetworkPath', 'getNetworkPaths']));
    expect(methods.some((m) => /set|create|update|delete|write|put|patch|mutate|post/i.test(m))).toBe(false);
  });
  it('builds a mock client that returns synthetic data', async () => {
    const client = createTelemetryClient(loadTelemetryConfig({ NETWORK_TELEMETRY_MODE: 'mock' }), { now: () => NOW });
    expect((await client.getNetworkPaths()).every((p) => p.provenance.synthetic)).toBe(true);
  });
  it('surfaces telemetry error codes as safe, generic messages (no upstream detail)', () => {
    expect(new TelemetryError('TELEMETRY_UPSTREAM_TIMEOUT').message).toMatch(/timed out/);
    expect(TelemetryError.fromStatus(503).transient).toBe(true);
    expect(TelemetryError.fromStatus(401).code).toBe('TELEMETRY_AUTH');
  });
});

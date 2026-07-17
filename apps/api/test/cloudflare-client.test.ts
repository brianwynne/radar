// Cloudflare connector clients: the live HTTP client (exercised with an injected fetch — no real
// Cloudflare is contacted) plus the mock and disabled clients. The token must never leak.
import { describe, it, expect, vi } from 'vitest';
import { HttpCloudflareReadClient } from '../src/cloudflare/http-client.js';
import { MockCloudflareClient, DisabledCloudflareClient } from '../src/cloudflare/mock-client.js';
import { CloudflareError } from '../src/cloudflare/errors.js';

const TOKEN = 'cf-super-secret-token';
const ok = (result: unknown, info?: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result, result_info: info ?? { page: 1, total_pages: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });

const POOLS = [
  { id: 'p-ctw', name: 'live-realta-citywest', enabled: true, healthy: true, monitor: 'm1', minimum_origins: 1,
    origin_steering: { policy: 'least_outstanding_requests' }, load_shedding: { default_percent: 5, default_policy: 'hash', session_percent: 0, session_policy: 'hash' },
    check_regions: ['WEU'], notification_email: 'noc@rte.ie',
    origins: [{ name: 'ctw-1', address: '185.54.105.0', weight: 1, enabled: true, healthy: true, header: { Host: ['origin.rte.ie'] } }, { name: 'ctw-2', address: '185.54.105.4', weight: 1, enabled: true, healthy: false, failure_reason: 'refused' }] },
  { id: 'p-pw', name: 'live-realta-parkwest', enabled: true, healthy: true, monitor: 'm1', minimum_origins: 1,
    origins: [{ name: 'pw-1', address: '185.54.106.0', weight: 1, enabled: true, healthy: true }] },
];
const MONITORS = [{ id: 'm1', type: 'https', method: 'GET', path: '/health', expected_codes: '200', expected_body: 'OK', interval: 60, timeout: 5, retries: 2, port: 443, consecutive_up: 2, consecutive_down: 3, follow_redirects: false, allow_insecure: false }];
// Pool health endpoint: per-region origin health + RTT.
const POOL_HEALTH = { pop_health: { WEU: { healthy: true, origins: [
  { '185.54.105.0': { healthy: true, rtt: '12ms', failure_reason: 'No failures' } },
  { '185.54.105.4': { healthy: false, rtt: '0ms', failure_reason: 'connection refused' } },
  { '185.54.106.0': { healthy: true, rtt: '15.5ms', failure_reason: 'No failures' } },
] } } };
const ZONES = [{ id: 'z-rte', name: 'rte.ie' }, { id: 'z-arpa', name: '104.54.185.in-addr.arpa' }];
const LBS = [
  { id: 'lb-live', name: 'liveedge.rte.ie', zone_name: 'rte.ie', enabled: true, proxied: false, steering_policy: 'random',
    default_pools: ['p-ctw', 'p-pw'], fallback_pool: 'p-pw', region_pools: { WEU: ['p-ctw'] }, pop_pools: {}, country_pools: { IE: ['p-ctw'] },
    session_affinity: 'cookie', session_affinity_ttl: 1800, session_affinity_attributes: { samesite: 'Auto', secure: 'Auto', drain_duration: 60, zero_downtime_failover: 'sticky' },
    adaptive_routing: { failover_across_pools: true }, ttl: 30,
    location_strategy: { mode: 'pop' }, random_steering: { pool_weights: { 'p-ctw': 0.7, 'p-pw': 0.3 }, default_weight: 1 } },
];
// GraphQL LB-analytics observed traffic (a different envelope: { data } not { success }).
const GRAPHQL = { data: { viewer: { zones: [{ loadBalancingRequestsAdaptiveGroups: [
  { count: 100, dimensions: { lbName: 'liveedge.rte.ie', selectedPoolName: 'live-realta-citywest', selectedOriginName: 'ctw-1', region: 'WEU', coloCode: 'DUB' } },
  { count: 50, dimensions: { lbName: 'liveedge.rte.ie', selectedPoolName: 'live-realta-parkwest', selectedOriginName: 'pw-1', region: 'WEU', coloCode: 'DUB' } },
] }] } } };
const raw = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Route a request path to the right Cloudflare fixture. */
function handler(path: string): Response {
  if (path.endsWith('/graphql')) return raw(GRAPHQL);
  if (path.includes('/load_balancers/monitors')) return ok(MONITORS);
  if (path.includes('/load_balancers/pools/') && path.endsWith('/health')) return ok(POOL_HEALTH);
  if (path.includes('/load_balancers/pools')) return ok(POOLS);
  if (path.includes('/zones/z-rte/load_balancers')) return ok(LBS);
  if (path.startsWith('/zones?') || path.startsWith('/zones&') || /\/zones\?/.test(path)) return ok(ZONES);
  return new Response('', { status: 404 });
}

function client(fetchImpl: typeof fetch, lbZones: string[] = ['rte.ie']) {
  return new HttpCloudflareReadClient({
    apiBase: 'https://cf.example', token: TOKEN, accountId: 'acct-1', lbZones,
    timeoutMs: 2000, maxRetries: 2, fetchImpl, sleep: async () => undefined, random: () => 0.5, now: () => Date.parse('2026-07-16T12:00:00Z'),
  });
}

function routingFetch(h: (path: string, call: number) => Response | Error): { fn: typeof fetch; calls: { auth: string | null }[] } {
  const calls: { auth: string | null }[] = [];
  const counts = new Map<string, number>();
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('https://cf.example', '');
    calls.push({ auth: new Headers(init?.headers).get('authorization') });
    const key = path.split('?')[0];
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const r = h(path, n);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}

describe('HttpCloudflareReadClient', () => {
  it('builds a snapshot: pools + origins + health, and load balancers with pool names resolved', async () => {
    const { fn, calls } = routingFetch((p) => handler(p));
    const snap = await client(fn).getSnapshot('cid');
    expect(snap.source).toBe('cloudflare');
    expect(snap.pools.map((p) => p.name)).toEqual(['live-realta-citywest', 'live-realta-parkwest']);
    const ctw = snap.pools.find((p) => p.name === 'live-realta-citywest')!;
    expect(ctw.totalOrigins).toBe(2);
    expect(ctw.healthyOrigins).toBe(1); // one origin healthy:false
    // Load balancer: steering resolved to pool NAMES, not ids.
    const lb = snap.loadBalancers.find((l) => l.name === 'liveedge.rte.ie')!;
    expect(lb.steeringPolicy).toBe('random');
    expect(lb.defaultPools.map((p) => p.poolName)).toEqual(['live-realta-citywest', 'live-realta-parkwest']);
    expect(lb.fallbackPool?.poolName).toBe('live-realta-parkwest');
    expect(lb.regionPools.WEU.map((p) => p.poolName)).toEqual(['live-realta-citywest']);
    // Summary counts unhealthy origins.
    expect(snap.summary).toMatchObject({ loadBalancerCount: 1, poolCount: 2, originCount: 3, unhealthyOrigins: 1 });
    // Every request carried the bearer token.
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('enriches with the health-check spec, steering weights and observed traffic', async () => {
    const { fn } = routingFetch((p) => handler(p));
    const snap = await client(fn).getSnapshot('cid');
    // Pool carries its resolved health-check (from the monitor).
    const ctw = snap.pools.find((p) => p.name === 'live-realta-citywest')!;
    expect(ctw.healthCheck).toMatchObject({ type: 'https', path: '/health', expectedCodes: '200', intervalSeconds: 60, retries: 2 });
    // Steering weights + location strategy.
    const lb = snap.loadBalancers.find((l) => l.name === 'liveedge.rte.ie')!;
    expect(lb.locationStrategy).toBe('pop');
    expect(lb.defaultPools.map((p) => p.weight)).toEqual([0.7, 0.3]);
    // Observed traffic (from GraphQL analytics): shares per pool.
    expect(lb.observed?.totalRequests).toBe(150);
    expect(lb.observed?.byPool).toEqual([
      { key: 'live-realta-citywest', requests: 100, sharePercent: 66.7 },
      { key: 'live-realta-parkwest', requests: 50, sharePercent: 33.3 },
    ]);
    expect(lb.observed?.byColo[0]).toMatchObject({ key: 'DUB', requests: 150 });
  });

  it('surfaces the richer fields: per-origin RTT/region health, origin steering, load shedding, session affinity, adaptive routing, by-origin traffic', async () => {
    const { fn } = routingFetch((p) => handler(p));
    const snap = await client(fn).getSnapshot('cid');
    const ctw = snap.pools.find((p) => p.name === 'live-realta-citywest')!;

    // Pool-level config.
    expect(ctw.originSteeringPolicy).toBe('least_outstanding_requests');
    expect(ctw.loadShedding).toMatchObject({ defaultPercent: 5, defaultPolicy: 'hash' });
    expect(ctw.checkRegions).toEqual(['WEU']);
    expect(ctw.notificationEmail).toBe('noc@rte.ie');
    expect(ctw.healthCheck).toMatchObject({ port: 443, consecutiveUp: 2, consecutiveDown: 3, followRedirects: false });

    // Per-origin RTT + region health from the pool health endpoint, and the Host header.
    const o1 = ctw.origins.find((o) => o.address === '185.54.105.0')!;
    expect(o1.rttMs).toBe(12);
    expect(o1.hostHeader).toBe('origin.rte.ie');
    expect(o1.regionHealth).toEqual([{ region: 'WEU', healthy: true, rttMs: 12, failureReason: 'No failures' }]);
    const o2 = ctw.origins.find((o) => o.address === '185.54.105.4')!;
    expect(o2.regionHealth[0]).toMatchObject({ healthy: false, failureReason: 'connection refused' });

    // LB-level config.
    const lb = snap.loadBalancers.find((l) => l.name === 'liveedge.rte.ie')!;
    expect(lb.sessionAffinity).toBe('cookie');
    expect(lb.sessionAffinityTtl).toBe(1800);
    expect(lb.sessionAffinityAttributes).toMatchObject({ drainDuration: 60, zeroDowntimeFailover: 'sticky' });
    expect(lb.adaptiveRoutingFailoverAcrossPools).toBe(true);
    expect(lb.countryPools.IE.map((p) => p.poolName)).toEqual(['live-realta-citywest']);
    expect(lb.randomSteeringDefaultWeight).toBe(1);
    expect(lb.ttlSeconds).toBe(30);

    // Observed by selected origin.
    expect(lb.observed?.byOrigin).toEqual([
      { key: 'ctw-1', requests: 100, sharePercent: 66.7 },
      { key: 'pw-1', requests: 50, sharePercent: 33.3 },
    ]);
  });

  it('auto-discovers non-reverse-DNS zones when none are configured (skips .arpa)', async () => {
    const seen: string[] = [];
    const { fn } = routingFetch((p) => { if (p.includes('/load_balancers') && p.includes('/zones/')) seen.push(p.split('/')[2]); return handler(p); });
    await client(fn, []).getSnapshot(); // no configured zones → discover
    expect(seen).toContain('z-rte');
    expect(seen).not.toContain('z-arpa'); // reverse-DNS zone is never probed for load balancers
  });

  it('maps 403 to CLOUDFLARE_AUTH and never leaks the token', async () => {
    const { fn } = routingFetch(() => new Response('forbidden', { status: 403 }));
    const err = await client(fn).getSnapshot().catch((e: unknown) => e as CloudflareError);
    expect(err).toBeInstanceOf(CloudflareError);
    expect((err as CloudflareError).code).toBe('CLOUDFLARE_AUTH');
    expect(JSON.stringify(err) + (err as Error).message + ((err as Error).stack ?? '')).not.toContain(TOKEN);
  });

  it('retries a transient 503 then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fn } = routingFetch((p, call) => (p.includes('/load_balancers/pools') && !p.includes('/health') && call === 1 ? new Response('', { status: 503 }) : handler(p)));
    const c = new HttpCloudflareReadClient({ apiBase: 'https://cf.example', token: TOKEN, accountId: 'acct-1', lbZones: ['rte.ie'], timeoutMs: 2000, maxRetries: 2, fetchImpl: fn, sleep, random: () => 0.5 });
    const snap = await c.getSnapshot();
    expect(snap.pools.length).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('MockCloudflareClient / DisabledCloudflareClient', () => {
  it('mock returns a synthetic snapshot with resolved steering', async () => {
    const snap = await new MockCloudflareClient(() => 0).getSnapshot();
    expect(snap.source).toBe('mock');
    expect(snap.provenance.synthetic).toBe(true);
    expect(snap.loadBalancers[0].defaultPools[0].poolName).toBe('live-realta-citywest');
    expect(snap.summary.unhealthyOrigins).toBe(1); // one mock origin is unhealthy
  });

  it('disabled returns an honest not-connected snapshot', async () => {
    const snap = await new DisabledCloudflareClient(() => 0).getSnapshot();
    expect(snap.source).toBe('disabled');
    expect(snap.pools).toHaveLength(0);
    expect(snap.loadBalancers).toHaveLength(0);
  });
});

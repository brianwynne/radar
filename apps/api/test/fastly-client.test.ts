// Fastly connector clients: the live HTTP client (exercised with an injected fetch — no real
// Fastly is contacted) plus the mock and disabled clients. The token must never leak.
import { describe, it, expect, vi } from 'vitest';
import { HttpFastlyReadClient } from '../src/fastly/http-client.js';
import { MockFastlyClient, DisabledFastlyClient } from '../src/fastly/mock-client.js';
import { FastlyError } from '../src/fastly/errors.js';

const TOKEN = 'fastly-super-secret-token';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SERVICES = [
  { id: 'svc-vod', name: 'RTÉ Player VOD', versions: [{ number: 42, active: true }, { number: 41, active: false }] },
  { id: 'svc-live', name: 'RTÉ Live', versions: [{ number: 7, active: true }] },
];
// Per-minute buckets (oldest first). The connector surfaces the LATEST finalised minute, so the
// second VOD bucket (start_time 1060) is the one that should be reported, not a window sum.
const STATS_VOD = { status: 'success', meta: { by: 'minute' }, data: [
  { start_time: 1000, requests: 600, hits: 540, miss: 60, bandwidth: 6_000_000, origin_fetches: 55, status_2xx: 580, status_3xx: 10, status_4xx: 8, status_5xx: 2 },
  { start_time: 1060, requests: 400, hits: 360, miss: 40, bandwidth: 4_000_000, origin_fetches: 35, status_2xx: 388, status_3xx: 6, status_4xx: 4, status_5xx: 2 },
] };
const STATS_LIVE = { status: 'success', meta: { by: 'minute' }, data: [
  { start_time: 1060, requests: 200, hits: 120, miss: 80, bandwidth: 2_000_000, origin_fetches: 70, status_2xx: 180, status_3xx: 4, status_4xx: 6, status_5xx: 10 },
] };

function handler(path: string): Response {
  if (path.startsWith('/service?') || path === '/service') return json(SERVICES);
  if (path.includes('/stats/service/svc-vod')) return json(STATS_VOD);
  if (path.includes('/stats/service/svc-live')) return json(STATS_LIVE);
  return new Response('', { status: 404 });
}

function client(fetchImpl: typeof fetch, serviceIds: string[] = []) {
  return new HttpFastlyReadClient({
    apiBase: 'https://fastly.example', token: TOKEN, serviceIds, windowMinutes: 10,
    timeoutMs: 2000, maxRetries: 2, fetchImpl, sleep: async () => undefined, random: () => 0.5, now: () => Date.parse('2026-07-16T12:00:00Z'),
  });
}

function routingFetch(h: (path: string, call: number) => Response | Error): { fn: typeof fetch; calls: { key: string | null }[] } {
  const calls: { key: string | null }[] = [];
  const counts = new Map<string, number>();
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('https://fastly.example', '');
    calls.push({ key: new Headers(init?.headers).get('fastly-key') });
    const key = path.split('?')[0];
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const r = h(path, n);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}

describe('HttpFastlyReadClient', () => {
  it('lists services and aggregates per-minute stats into hit ratio, rps, offload and error rate', async () => {
    const { fn, calls } = routingFetch((p) => handler(p));
    const snap = await client(fn).getSnapshot('cid');
    expect(snap.source).toBe('fastly');
    expect(snap.services.map((s) => s.serviceName)).toEqual(['RTÉ Player VOD', 'RTÉ Live']); // sorted by rps desc

    const vod = snap.services.find((s) => s.serviceId === 'svc-vod')!;
    expect(vod.requests).toBe(400); // the LATEST finalised minute (start_time 1060), not a window sum
    expect(vod.hits).toBe(360);
    expect(vod.miss).toBe(40);
    expect(vod.hitRatioPercent).toBe(90); // 360 / 400 cacheable
    expect(vod.windowSeconds).toBe(60); // one finalised minute
    expect(vod.requestsPerSecond).toBeCloseTo(400 / 60, 1); // that minute's rate
    expect(vod.status5xx).toBe(2);
    expect(vod.errorRatePercent).toBe(0.5); // 2 / 400
    expect(vod.originOffloadPercent).toBe(91.3); // 1 - 35/400

    // Summary: weighted hit ratio + service count.
    expect(snap.summary.serviceCount).toBe(2);
    expect(snap.summary.avgHitRatioPercent).toBeGreaterThan(0);

    // Every request carried the Fastly-Key header, none leaked elsewhere.
    expect(calls.every((c) => c.key === TOKEN)).toBe(true);
  });

  it('observes only the configured service ids when provided', async () => {
    const seen: string[] = [];
    const { fn } = routingFetch((p) => { if (p.includes('/stats/service/')) seen.push(p.split('/stats/service/')[1].split('?')[0]); return handler(p); });
    const snap = await client(fn, ['svc-live']).getSnapshot();
    expect(snap.services.map((s) => s.serviceId)).toEqual(['svc-live']);
    expect(seen).toEqual(['svc-live']);
  });

  it('maps 403 to FASTLY_AUTH and never leaks the token', async () => {
    const { fn } = routingFetch(() => new Response('forbidden', { status: 403 }));
    const err = await client(fn).getSnapshot().catch((e: unknown) => e as FastlyError);
    expect(err).toBeInstanceOf(FastlyError);
    expect((err as FastlyError).code).toBe('FASTLY_AUTH');
    expect(JSON.stringify(err) + (err as Error).message + ((err as Error).stack ?? '')).not.toContain(TOKEN);
  });

  it('a per-service stats failure is a warning; the service is still listed', async () => {
    const { fn } = routingFetch((p) => (p.includes('/stats/service/svc-live') ? new Response('nope', { status: 400 }) : handler(p)));
    const snap = await client(fn).getSnapshot();
    expect(snap.services.map((s) => s.serviceId).sort()).toEqual(['svc-live', 'svc-vod']);
    const live = snap.services.find((s) => s.serviceId === 'svc-live')!;
    expect(live.requests).toBe(0); // no fabricated numbers
    expect(live.hitRatioPercent).toBeNull();
    expect(snap.warnings.some((w) => /svc-live/.test(w))).toBe(true);
  });

  it('retries a transient 503 then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fn } = routingFetch((p, call) => (p.includes('/stats/service/svc-vod') && call === 1 ? new Response('', { status: 503 }) : handler(p)));
    const c = new HttpFastlyReadClient({ apiBase: 'https://fastly.example', token: TOKEN, serviceIds: [], windowMinutes: 10, timeoutMs: 2000, maxRetries: 2, fetchImpl: fn, sleep, random: () => 0.5, now: () => Date.parse('2026-07-16T12:00:00Z') });
    const snap = await c.getSnapshot();
    expect(snap.services.find((s) => s.serviceId === 'svc-vod')!.requests).toBe(400); // latest finalised minute
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('MockFastlyClient / DisabledFastlyClient', () => {
  it('mock returns a synthetic snapshot with realistic services', async () => {
    const snap = await new MockFastlyClient(() => 0).getSnapshot();
    expect(snap.source).toBe('mock');
    expect(snap.provenance.synthetic).toBe(true);
    expect(snap.services.length).toBeGreaterThan(0);
    expect(snap.services[0].hitRatioPercent).toBeGreaterThan(0);
  });

  it('disabled returns an honest not-connected snapshot', async () => {
    const snap = await new DisabledFastlyClient(() => 0).getSnapshot();
    expect(snap.source).toBe('disabled');
    expect(snap.services).toHaveLength(0);
    expect(snap.summary.serviceCount).toBe(0);
  });
});

// Read-only cache/origin telemetry routes: RBAC, filtering, role-aware detail, 404, and the
// read-only / informational guarantees (no write route; no credentials/URLs; no steering
// mutation).
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockCacheTelemetryClient } from '../src/telemetry/cache-index.js';
import { resolveNodeMappings, resolveOriginMapping, resolvePoolMappings } from '../src/telemetry/pools.js';
import type { CacheTelemetryClient } from '../src/telemetry/cache-types.js';

const NOW = Date.parse('2026-07-12T12:00:00Z');
function client(extra: { stalePoolIds?: string[] } = {}): CacheTelemetryClient {
  return new MockCacheTelemetryClient({ pools: resolvePoolMappings(), nodes: resolveNodeMappings(), origin: resolveOriginMapping(), staleAfterSeconds: 120, now: () => NOW, ...extra });
}

async function app(role: string, opts: { client?: CacheTelemetryClient; auth?: boolean } = {}): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(opts.auth ?? true), RADAR_DEV_ROLE: role }), {
    cacheTelemetryClient: opts.client ?? client(),
    cacheTelemetryMode: 'mock',
  });
  await a.ready();
  return a;
}

describe('GET /api/v1/telemetry/cache-pools', () => {
  it('is readable by a NOC viewer with configured + observed fields and deterministic headroom (no detail)', async () => {
    const a = await app('NOC_VIEWER');
    const res = await a.inject({ url: '/api/v1/telemetry/cache-pools' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.count).toBe(4);
    expect(b.provenance.notice).toMatch(/not automatically modifying NS1 or Cloudflare/i);
    const donny = b.items.find((i: { poolId: string }) => i.poolId === 'donnybrook-1');
    expect(donny).toMatchObject({ status: 'healthy', cacheNodeCount: 2, configuredCapacityBps: 160e9 });
    expect(donny.headroomBps).toBe(donny.configuredCapacityBps - donny.observedOutboundBps);
    expect(donny.warningPercent).toBeUndefined(); // gated behind ns1.detail.read
    await a.close();
  });

  it('reveals thresholds/warnings to a Viewing Engineer', async () => {
    const a = await app('VIEWING_ENGINEER');
    const donny = (await a.inject({ url: '/api/v1/telemetry/cache-pools' })).json().items.find((i: { poolId: string }) => i.poolId === 'donnybrook-1');
    expect(donny.warningPercent).toBe(80);
    expect(donny.criticalPercent).toBe(90);
    await a.close();
  });

  it('never returns source URLs or credentials', async () => {
    const a = await app('VIEWING_ENGINEER');
    const raw = (await a.inject({ url: '/api/v1/telemetry/cache-pools' })).body;
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw.toLowerCase()).not.toContain('authorization');
    await a.close();
  });

  it('filters by site, status and stale', async () => {
    const a = await app('NOC_VIEWER', { client: client({ stalePoolIds: ['donnybrook-1'] }) });
    expect((await a.inject({ url: '/api/v1/telemetry/cache-pools?site=External' })).json().count).toBe(2);
    expect((await a.inject({ url: '/api/v1/telemetry/cache-pools?status=critical' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/telemetry/cache-pools?stale=true' })).json().count).toBe(1);
    await a.close();
  });

  it('rejects invalid filters (400), unauthenticated (401), and exposes no write route', async () => {
    const a = await app('ENGINEER');
    expect((await a.inject({ url: '/api/v1/telemetry/cache-pools?status=bogus' })).statusCode).toBe(400);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await a.inject({ method, url: '/api/v1/telemetry/cache-pools' })).statusCode).toBe(404);
    }
    await a.close();
    const anon = await app('NOC_VIEWER', { auth: false });
    expect((await anon.inject({ url: '/api/v1/telemetry/cache-pools' })).statusCode).toBe(401);
    await anon.close();
  });
});

describe('GET /api/v1/telemetry/cache-nodes', () => {
  it('lists nodes, filters by pool, and 404s an unknown node', async () => {
    const a = await app('NOC_VIEWER');
    expect((await a.inject({ url: '/api/v1/telemetry/cache-nodes' })).json().count).toBe(12);
    expect((await a.inject({ url: '/api/v1/telemetry/cache-nodes?poolId=external-1' })).json().count).toBe(4);
    expect((await a.inject({ url: '/api/v1/telemetry/cache-nodes/donnybrook-1-n1' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/api/v1/telemetry/cache-nodes/nope' })).statusCode).toBe(404);
    await a.close();
  });
});

describe('GET /api/v1/telemetry/origin', () => {
  it('returns origin health to a NOC viewer', async () => {
    const a = await app('NOC_VIEWER');
    const res = await a.inject({ url: '/api/v1/telemetry/origin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toMatchObject({ originId: 'origin' });
    expect(typeof res.json().item.cpuUtilisationPercent).toBe('number');
    await a.close();
  });
});

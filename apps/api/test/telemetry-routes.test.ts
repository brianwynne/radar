// Read-only telemetry routes: RBAC, filtering, role-aware detail, and the read-only /
// informational guarantees (no write route; no credentials or source URLs in responses).
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockNetworkPathTelemetryClient, resolveMappings } from '../src/telemetry/index.js';
import type { NetworkPathTelemetryClient } from '../src/telemetry/types.js';

const NOW = Date.parse('2026-07-11T12:00:00Z');
function mockClient(extra: { stalePathIds?: string[]; unavailablePathIds?: string[] } = {}): NetworkPathTelemetryClient {
  return new MockNetworkPathTelemetryClient({ mappings: resolveMappings(), staleAfterSeconds: 120, now: () => NOW, ...extra });
}

async function app(role: string, opts: { client?: NetworkPathTelemetryClient; auth?: boolean } = {}): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(opts.auth ?? true), RADAR_DEV_ROLE: role }), {
    telemetryClient: opts.client ?? mockClient(),
    telemetryMode: 'mock',
  });
  await a.ready();
  return a;
}

describe('GET /api/v1/telemetry/network-paths', () => {
  it('is readable by a NOC viewer and returns configured + observed fields (no engineering detail)', async () => {
    const a = await app('NOC_VIEWER');
    const res = await a.inject({ url: '/api/v1/telemetry/network-paths' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.count).toBe(4);
    expect(b.provenance.notice).toMatch(/informational/i);
    const eir = b.items.find((i: { pathId: string }) => i.pathId === 'eir-pni');
    expect(eir).toMatchObject({ status: 'healthy', configuredCapacityBps: 100e9, configuredTargetPercent: 70, observedUtilisationPercent: 52 });
    expect(eir.interfaceIdentity).toBeUndefined(); // gated behind ns1.detail.read
    expect(eir.warningThresholdPercent).toBeUndefined();
    await a.close();
  });

  it('reveals engineering detail (interface, thresholds, warnings) to a Viewing Engineer', async () => {
    const a = await app('VIEWING_ENGINEER');
    const eir = (await a.inject({ url: '/api/v1/telemetry/network-paths' })).json().items.find((i: { pathId: string }) => i.pathId === 'eir-pni');
    expect(eir.interfaceIdentity).toBe('pni-eir');
    expect(eir.warningThresholdPercent).toBe(80);
    expect(eir.criticalThresholdPercent).toBe(90);
    await a.close();
  });

  it('never returns source URLs, queries or credentials', async () => {
    const a = await app('VIEWING_ENGINEER');
    const raw = (await a.inject({ url: '/api/v1/telemetry/network-paths' })).body;
    expect(raw).not.toMatch(/https?:\/\//); // no prometheus/base URL
    expect(raw.toLowerCase()).not.toContain('authorization');
    expect(raw.toLowerCase()).not.toContain('bearer');
    await a.close();
  });

  it('filters by pathType, status and stale', async () => {
    const a = await app('NOC_VIEWER', { client: mockClient({ stalePathIds: ['inex'] }) });
    expect((await a.inject({ url: '/api/v1/telemetry/network-paths?pathType=PNI' })).json().count).toBe(2);
    expect((await a.inject({ url: '/api/v1/telemetry/network-paths?status=critical' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/telemetry/network-paths?stale=true' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/telemetry/network-paths?stale=false' })).json().count).toBe(3);
    await a.close();
  });

  it('rejects an invalid filter (400) and unauthenticated (401)', async () => {
    const a = await app('NOC_VIEWER');
    expect((await a.inject({ url: '/api/v1/telemetry/network-paths?pathType=bogus' })).statusCode).toBe(400);
    await a.close();
    const anon = await app('NOC_VIEWER', { auth: false });
    expect((await anon.inject({ url: '/api/v1/telemetry/network-paths' })).statusCode).toBe(401);
    await anon.close();
  });

  it('exposes no write route — telemetry can never trigger an NS1 write or state change', async () => {
    const a = await app('ENGINEER');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await a.inject({ method, url: '/api/v1/telemetry/network-paths' })).statusCode).toBe(404);
    }
    await a.close();
  });
});

describe('GET /api/v1/telemetry/network-paths/:pathId', () => {
  it('returns one path and 404 for an unknown id', async () => {
    const a = await app('NOC_VIEWER');
    const res = await a.inject({ url: '/api/v1/telemetry/network-paths/transit' });
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toMatchObject({ pathId: 'transit', status: 'critical' });
    expect((await a.inject({ url: '/api/v1/telemetry/network-paths/nope' })).statusCode).toBe(404);
    await a.close();
  });
});

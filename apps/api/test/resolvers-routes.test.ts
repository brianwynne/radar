// Resolver-reader routes: RBAC, the per-ISP aggregate shape (platform, pool split, TTL honouring),
// the Three no-coverage gap, the brief cache, and the check-now / polling-toggle controls.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createAtlasManager, loadAtlasConfig } from '../src/atlas/index.js';
import { MockAtlasManager } from '../src/atlas/mock.js';
import type { ResolverManager, ResolverSnapshot } from '../src/atlas/index.js';
import type { ResolverIdentitySnapshot } from '../src/atlas/types.js';

const mockManager = () => new MockAtlasManager(loadAtlasConfig({ ATLAS_ENABLED: 'true', ATLAS_MODE: 'mock' }));

async function app(role: string, manager?: ResolverManager, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    atlasManager: manager ?? mockManager(),
  });
  await a.ready();
  return a;
}

describe('resolver-reader route', () => {
  it('401 when unauthenticated', async () => {
    const a = await app('NOC_VIEWER', undefined, false);
    expect((await a.inject({ url: '/api/v1/network/resolvers' })).statusCode).toBe(401);
    await a.close();
  });

  it('baseline: per-ISP platform, pool split, TTL honouring', async () => {
    const a = await app('NOC_VIEWER');
    const body = (await a.inject({ url: '/api/v1/network/resolvers' })).json() as ResolverSnapshot;
    expect(body.target).toBe('live.rte.ie');
    const eir = body.isps.find((i) => i.isp === 'Eir')!;
    expect(eir.covered).toBe(true);
    expect(eir.platforms.Réalta).toBeGreaterThan(0);
    expect(Object.keys(eir.pools)).toEqual(expect.arrayContaining(['185.54.104', '185.54.105'])); // CW/PW split
    expect(eir.honoursLowTtl).toBe(true);
    expect(body.pollingEnabled).toBe(true);
    await a.close();
  });

  it('flags Three as a no-coverage gap (no fabricated data)', async () => {
    const a = await app('NOC_VIEWER');
    const body = (await a.inject({ url: '/api/v1/network/resolvers' })).json() as ResolverSnapshot;
    const three = body.isps.find((i) => i.isp === 'Three')!;
    expect(three.covered).toBe(false);
    expect(three.measurementId).toBeNull();
    expect(three.samples).toEqual([]);
    await a.close();
  });

  it('never leaks the key; caches so a refresh does not re-hit Atlas', async () => {
    let calls = 0;
    const m = mockManager();
    const counting: ResolverManager = { ...m, snapshot: async () => { calls++; return m.snapshot(); }, pollingEnabled: () => m.pollingEnabled() };
    const a = await app('NOC_VIEWER', counting);
    const r1 = await a.inject({ url: '/api/v1/network/resolvers' });
    await a.inject({ url: '/api/v1/network/resolvers' });
    expect(calls).toBe(1);
    expect(JSON.stringify(r1.json())).not.toMatch(/atlas.*key|Authorization/i);
    await a.close();
  });

  it('check-now is engineer-gated; a viewer cannot fire measurements', async () => {
    const viewer = await app('NOC_VIEWER');
    expect((await viewer.inject({ method: 'POST', url: '/api/v1/network/resolvers/check' })).statusCode).toBe(403);
    await viewer.close();
    const eng = await app('ENGINEER');
    const res = await eng.inject({ method: 'POST', url: '/api/v1/network/resolvers/check' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.length).toBeGreaterThan(0);
    await eng.close();
  });

  it('NEVER shows mock: the default (disabled) manager returns an honest empty state', async () => {
    const disabled = createAtlasManager(loadAtlasConfig({})); // ATLAS_ENABLED unset → disabled
    const a = await app('NOC_VIEWER', disabled);
    const body = (await a.inject({ url: '/api/v1/network/resolvers' })).json() as ResolverSnapshot;
    expect(body.provenance.source).toBe('disabled');
    expect(body.provenance.synthetic).toBe(false); // not synthetic — just not connected
    expect(body.isps).toEqual([]);
    await a.close();
  });

  it('polling toggle is engineer-gated and flips the flag', async () => {
    const eng = await app('ENGINEER');
    const off = await eng.inject({ method: 'POST', url: '/api/v1/network/resolvers/polling', payload: { enabled: false } });
    expect(off.json().pollingEnabled).toBe(false);
    await eng.close();
    const viewer = await app('NOC_VIEWER');
    expect((await viewer.inject({ method: 'POST', url: '/api/v1/network/resolvers/polling', payload: { enabled: false } })).statusCode).toBe(403);
    await viewer.close();
  });
});

describe('resolver-identity route', () => {
  it('401 when unauthenticated', async () => {
    const a = await app('NOC_VIEWER', undefined, false);
    expect((await a.inject({ url: '/api/v1/network/resolvers/identity' })).statusCode).toBe(401);
    await a.close();
  });

  it('returns per-ISP real recursives split into ISP-own vs public-via-CPE, with the ECS verdict', async () => {
    const a = await app('NOC_VIEWER');
    const body = (await a.inject({ url: '/api/v1/network/resolvers/identity' })).json() as ResolverIdentitySnapshot;
    const eir = body.isps.find((i) => i.isp === 'Eir')!;
    expect(eir.covered).toBe(true);
    expect(eir.ispResolverCount).toBe(1);
    expect(eir.publicResolverCount).toBe(1);
    expect(eir.resolvers[0]).toMatchObject({ public: false }); // own listed first
    expect(eir.sendsEcs).toBe(true); // Eir's own recursive forwards ECS /24
    expect(eir.ecsPrefixes).toContain(24);
    await a.close();
  });

  it('flags Three as a no-coverage gap (no fabricated resolvers)', async () => {
    const a = await app('NOC_VIEWER');
    const body = (await a.inject({ url: '/api/v1/network/resolvers/identity' })).json() as ResolverIdentitySnapshot;
    const three = body.isps.find((i) => i.isp === 'Three')!;
    expect(three.covered).toBe(false);
    expect(three.resolvers).toEqual([]);
    await a.close();
  });

  it('disabled manager returns an honest empty identity, never mock', async () => {
    const disabled = createAtlasManager(loadAtlasConfig({}));
    const a = await app('NOC_VIEWER', disabled);
    const body = (await a.inject({ url: '/api/v1/network/resolvers/identity' })).json() as ResolverIdentitySnapshot;
    expect(body.provenance.source).toBe('disabled');
    expect(body.isps).toEqual([]);
    await a.close();
  });
});

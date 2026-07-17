// Active steering-record resolution: resolves the entry's CNAME over DNS (live.rte.ie →
// livebase.nsone.rte.ie), maps the target to its NS1 zone (longest suffix), reports the active
// record + its filter-chain length, degrades gracefully when DNS/target can't be resolved, and
// enforces ns1.detail.read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ns1ReadClient } from '../src/ns1/client.js';
import { Ns1Error } from '../src/ns1/errors.js';

const ACTIVE = {
  zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME',
  answers: [{ answer: ['liveedge.rte.ie'] }],
  filters: [{ filter: 'geofence_country' }, { filter: 'netfence_asn' }, { filter: 'weighted_shuffle' }],
};

const client: Ns1ReadClient = {
  listZones: async () => [{ zone: 'nsone.rte.ie' }, { zone: 'nsone.rte.eu' }, { zone: 'livetest.rte.ie' }],
  getZone: async () => ({ records: [] }),
  getRecord: async (zone: string, domain: string) => {
    if (zone === 'nsone.rte.ie' && domain === 'livebase.nsone.rte.ie') return ACTIVE;
    throw new Ns1Error('NS1_NOT_FOUND', 'not found', 404);
  },
  getActivity: async () => [],
};

async function app(role: string, resolveCname?: (f: string) => Promise<string[]>, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    ns1Client: client,
    ns1ActiveResolveCname: resolveCname ?? (async () => ['livebase.nsone.rte.ie.']),
  });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('NS1 active-record resolution', () => {
  it('resolves the entry CNAME over DNS to the active record, maps its zone, reports the chain length', async () => {
    const a = await app('VIEWING_ENGINEER');
    const res = await a.inject({ url: '/api/v1/ns1/active-record' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entry).toBe('live.rte.ie');
    expect(body.target).toBe('livebase.nsone.rte.ie'); // trailing dot stripped
    expect(body.active).toEqual({ zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME' });
    expect(body.filterCount).toBe(3); // actively steering
    expect(body.warnings).toEqual([]);
    await a.close();
  });

  it('degrades gracefully when DNS resolution fails', async () => {
    const a = await app('VIEWING_ENGINEER', async () => { throw new Error('ENOTFOUND'); });
    const res = await a.inject({ url: '/api/v1/ns1/active-record' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active).toBeNull();
    expect(body.warnings.join(' ')).toMatch(/could not resolve/i);
    await a.close();
  });

  it('degrades gracefully when the target is outside the key-visible zones', async () => {
    const a = await app('VIEWING_ENGINEER', async () => ['live.rte.ie.akamaized.net.']); // not an NS1 zone we can see
    const body = (await a.inject({ url: '/api/v1/ns1/active-record' })).json();
    expect(body.target).toBe('live.rte.ie.akamaized.net');
    expect(body.active).toBeNull();
    expect(body.warnings.join(' ')).toMatch(/not within a zone/i);
    await a.close();
  });

  it('enforces ns1.detail.read (403 NOC viewer, 401 anonymous)', async () => {
    const viewer = await app('NOC_VIEWER');
    expect((await viewer.inject({ url: '/api/v1/ns1/active-record' })).statusCode).toBe(403);
    await viewer.close();
    const anon = await app('VIEWING_ENGINEER', undefined, false);
    expect((await anon.inject({ url: '/api/v1/ns1/active-record' })).statusCode).toBe(401);
    await anon.close();
  });
});

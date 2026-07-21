// Guarded NS1 create-record routes: engineer-gated, dry-run plan vs audited apply, blocked names.
import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpNs1RecordWriter } from '../src/ns1/record-writer.js';
import type { Ns1Config } from '../src/ns1/config.js';

const writerCfg: Ns1Config = {
  mode: 'live', baseUrl: 'https://api.nsone.net/v1', apiKey: 'k', writeApiKey: 'k',
  requestTimeoutMs: 5000, maxRetries: 2, cacheTtlSeconds: 30,
  writeEnabled: true, writeAllow: ['livetest.rte.ie', '*.livetest.rte.ie'],
};

const SOURCE = { id: 'abc', zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME', ttl: 300, answers: [{ answer: ['liveedge.rte.ie'] }], filters: [{ filter: 'up' }], use_client_subnet: true };
const stubReadClient = () => ({
  listZones: async () => [],
  getZone: async () => ({}),
  getRecord: async () => SOURCE,
  getActivity: async () => [],
});

async function app(role: string, fetchImpl?: typeof fetch, auth = true): Promise<FastifyInstance> {
  const writer = new HttpNs1RecordWriter(writerCfg, fetchImpl ?? ((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch));
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { ns1RecordWriter: writer, ns1Client: stubReadClient() });
  await a.ready();
  return a;
}
const VALID = { zone: 'rte.ie', domain: 'livetest.rte.ie', type: 'A', answers: ['185.54.104.4'], ttl: 30 };

describe('NS1 create-record routes', () => {
  it('401 unauthenticated', async () => {
    const a = await app('ENGINEER', undefined, false);
    expect((await a.inject({ method: 'POST', url: '/api/v1/ns1/records/plan', payload: VALID })).statusCode).toBe(401);
    await a.close();
  });

  it('is engineer-gated: a viewing engineer is 403 on plan and apply', async () => {
    const a = await app('VIEWING_ENGINEER');
    expect((await a.inject({ method: 'POST', url: '/api/v1/ns1/records/plan', payload: VALID })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/v1/ns1/records/apply', payload: VALID })).statusCode).toBe(403);
    await a.close();
  });

  it('capability reports the enabled state + allow-list', async () => {
    const a = await app('ENGINEER');
    const body = (await a.inject({ url: '/api/v1/ns1/records/capability' })).json();
    expect(body).toMatchObject({ writeEnabled: true, allowList: ['livetest.rte.ie', '*.livetest.rte.ie'] });
    await a.close();
  });

  it('plan is a pure dry-run — allowed plan, NO NS1 call', async () => {
    const fetchImpl = vi.fn();
    const a = await app('ENGINEER', fetchImpl as unknown as typeof fetch);
    const body = (await a.inject({ method: 'POST', url: '/api/v1/ns1/records/plan', payload: VALID })).json();
    expect(body.allowed).toBe(true);
    expect(body.request.path).toBe('/zones/rte.ie/livetest.rte.ie/A');
    expect(fetchImpl).not.toHaveBeenCalled(); // dry-run never touches NS1
    await a.close();
  });

  it('apply writes an allowed record and returns write-provenance', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'rec1' }), { status: 200 }));
    const a = await app('ENGINEER', fetchImpl as unknown as typeof fetch);
    const res = await a.inject({ method: 'POST', url: '/api/v1/ns1/records/apply', payload: VALID });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance).toMatchObject({ readOnly: false, write: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    await a.close();
  });

  it('apply of a protected/blocked name is refused with 400 and no NS1 call', async () => {
    const fetchImpl = vi.fn();
    const a = await app('ENGINEER', fetchImpl as unknown as typeof fetch);
    const res = await a.inject({ method: 'POST', url: '/api/v1/ns1/records/apply', payload: { ...VALID, domain: 'livebase.nsone.rte.ie', type: 'CNAME', answers: ['liveedge.rte.ie'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
    await a.close();
  });

  it('clone/plan reads the source and retargets it (dry-run, no NS1 write)', async () => {
    const fetchImpl = vi.fn();
    const a = await app('ENGINEER', fetchImpl as unknown as typeof fetch);
    const body = (await a.inject({ method: 'POST', url: '/api/v1/ns1/records/clone/plan', payload: { source: { zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME' }, target: { zone: 'rte.ie', domain: 'livetest.rte.ie', ttl: 30 } } })).json();
    expect(body.allowed).toBe(true);
    expect(body.request.body).toMatchObject({ domain: 'livetest.rte.ie', ttl: 30, filters: [{ filter: 'up' }] }); // inherited chain, retargeted
    expect(fetchImpl).not.toHaveBeenCalled(); // dry-run never writes
    await a.close();
  });

  it('clone/apply writes the retargeted record and audits as a clone', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'new' }), { status: 200 }));
    const a = await app('ENGINEER', fetchImpl as unknown as typeof fetch);
    const res = await a.inject({ method: 'POST', url: '/api/v1/ns1/records/clone/apply', payload: { source: { zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME' }, target: { zone: 'rte.ie', domain: 'livetest.rte.ie', ttl: 30 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.notice).toMatch(/cloned to/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await a.close();
  });
});

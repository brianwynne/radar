import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Ns1Error, type ActivityQuery, type Ns1ReadClient } from '../src/ns1/index.js';

async function makeApp(role: string | null, deps: Parameters<typeof buildApp>[1] = {}): Promise<FastifyInstance> {
  const env: Record<string, string> = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  if (role) Object.assign(env, { RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: role });
  else env.RADAR_DEV_AUTH = 'false';
  const app = await buildApp(loadConfig(env), deps);
  await app.ready();
  return app;
}

const URL = '/api/v1/ns1/activity';

describe('GET /api/v1/ns1/activity — RBAC', () => {
  it('401 when unauthenticated', async () => {
    const app = await makeApp(null);
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    await app.close();
  });
  it('403 for a NOC viewer (no audit.read)', async () => {
    const app = await makeApp('NOC_VIEWER');
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(403);
    await app.close();
  });
  it('200 for a Viewing Engineer and an Engineer', async () => {
    for (const role of ['VIEWING_ENGINEER', 'ENGINEER']) {
      const app = await makeApp(role);
      expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(200);
      await app.close();
    }
  });
});

describe('GET /api/v1/ns1/activity — data', () => {
  it('returns normalised mock activity with synthetic provenance', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provenance).toMatchObject({ source: 'ns1', mode: 'mock', synthetic: true, endpoint: '/v1/account/activity' });
    expect(body.mappingNote).toMatch(/fixture-derived/i);
    expect(body.items.length).toBeGreaterThan(0);
    const first = body.items[0];
    expect(first).toMatchObject({ action: 'update', resourceType: 'record', outcome: 'success' });
    expect(first.occurredAt).toBeDefined();
    expect(first.actor).toBe('brian@rte.ie');
    expect(first.raw).toBeDefined(); // raw preserved for the engineering panel
    await app.close();
  });

  it('filters server-side by action', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({ method: 'GET', url: `${URL}?action=view` });
    const items = res.json().items as { action: string }[];
    expect(items.length).toBe(1);
    expect(items.every((i) => i.action === 'view')).toBe(true);
    await app.close();
  });

  it('rejects an invalid query (limit) with 400', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    for (const q of ['limit=abc', 'limit=0', 'limit=-5']) {
      const res = await app.inject({ method: 'GET', url: `${URL}?${q}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_REQUEST');
    }
    await app.close();
  });

  it('retrieves via the client getActivity and never leaks credential-like fields', async () => {
    let called: ActivityQuery | undefined;
    const client: Ns1ReadClient = {
      listZones: async () => [],
      getZone: async () => ({}),
      getRecord: async () => ({}),
      getActivity: async (query?: ActivityQuery) => {
        called = query;
        // An entry that (hypothetically) carries sensitive keys — must be stripped.
        return [{ id: 'x', action: 'update', user: 'u', api_key: 'SECRET-KEY-VALUE', authorization: 'Bearer tok', token: 't' }];
      },
    };
    const app = await makeApp('VIEWING_ENGINEER', { ns1Client: client });
    const res = await app.inject({ method: 'GET', url: `${URL}?limit=10` });
    expect(res.statusCode).toBe(200);
    expect(called).toEqual({ limit: 10 }); // getActivity was used with the allow-listed limit
    expect(res.payload).not.toMatch(/SECRET-KEY-VALUE|Bearer tok/);
    const raw = res.json().items[0].raw;
    expect(raw.api_key).toBeUndefined();
    expect(raw.authorization).toBeUndefined();
    expect(raw.token).toBeUndefined();
    await app.close();
  });

  it('maps an NS1 upstream failure to a safe status', async () => {
    const client: Ns1ReadClient = {
      listZones: async () => [],
      getZone: async () => ({}),
      getRecord: async () => ({}),
      getActivity: async () => Promise.reject(new Ns1Error('NS1_UPSTREAM_TIMEOUT', undefined, { transient: true })),
    };
    const app = await makeApp('VIEWING_ENGINEER', { ns1Client: client });
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe('NS1_UPSTREAM_TIMEOUT');
    await app.close();
  });
});

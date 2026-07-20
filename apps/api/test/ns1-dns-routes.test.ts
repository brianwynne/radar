import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Ns1Error, type Ns1ReadClient } from '../src/ns1/index.js';

async function makeApp(
  role: string | null,
  deps: Parameters<typeof buildApp>[1] = {},
): Promise<FastifyInstance> {
  const env: Record<string, string> = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  if (role) {
    Object.assign(env, { RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: role });
  } else {
    env.RADAR_DEV_AUTH = 'false';
  }
  const app = await buildApp(loadConfig(env), deps);
  await app.ready();
  return app;
}

const RECORD_PATH = '/api/v1/ns1/zones/rte.ie/live.rte.ie/A';
const explainBody = {
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  type: 'A',
  scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: 5466 },
};

describe('NS1 routes — RBAC', () => {
  it('config is visible to a NOC viewer (dashboard.read) and shows the mock/synthetic banner', async () => {
    const app = await makeApp('NOC_VIEWER');
    const res = await app.inject({ method: 'GET', url: '/api/v1/ns1/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'mock', synthetic: true, readOnly: true });
    expect(res.json().disclaimer).toMatch(/SYNTHETIC/);
    await app.close();
  });

  it('reports the EFFECTIVE connector mode, not the startup mode, in /config and provenance', async () => {
    // Startup config is mock, but NS1 was switched to live via the connector (Integrations page).
    // The banner and every provenance must read live/non-synthetic — how the data was ACTUALLY served.
    const ns1Manager = { effectiveConnection: () => ({ mode: 'live' as const, baseUrl: 'https://api.nsone.net/v1' }) };
    const app = await makeApp('VIEWING_ENGINEER', { ns1Manager } as unknown as Parameters<typeof buildApp>[1]);
    const cfg = await app.inject({ method: 'GET', url: '/api/v1/ns1/config' });
    expect(cfg.json()).toMatchObject({ mode: 'live', synthetic: false });
    expect(cfg.json().disclaimer).toBeUndefined();
    const zones = await app.inject({ method: 'GET', url: '/api/v1/ns1/zones' });
    expect(zones.json().provenance).toMatchObject({ mode: 'live', synthetic: false });
    const explain = await app.inject({ method: 'POST', url: '/api/v1/dns/explain', payload: explainBody });
    expect(explain.json().provenance).toMatchObject({ mode: 'live', synthetic: false });
    await app.close();
  });

  it('zones/record/raw/explain are denied to a NOC viewer (403) but allowed to a Viewing Engineer', async () => {
    const noc = await makeApp('NOC_VIEWER');
    for (const url of ['/api/v1/ns1/zones', RECORD_PATH, `${RECORD_PATH}/raw`]) {
      expect((await noc.inject({ method: 'GET', url })).statusCode).toBe(403);
    }
    expect((await noc.inject({ method: 'POST', url: '/api/v1/dns/explain', payload: explainBody })).statusCode).toBe(403);
    await noc.close();

    const ve = await makeApp('VIEWING_ENGINEER');
    expect((await ve.inject({ method: 'GET', url: '/api/v1/ns1/zones' })).statusCode).toBe(200);
    expect((await ve.inject({ method: 'GET', url: `${RECORD_PATH}/raw` })).statusCode).toBe(200);
    await ve.close();
  });

  it('rejects unauthenticated callers with 401', async () => {
    const app = await makeApp(null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/ns1/zones' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/dns/explain', payload: explainBody })).statusCode).toBe(401);
    await app.close();
  });
});

describe('NS1 routes — read-only data with provenance', () => {
  it('lists zones with synthetic provenance in mock mode', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({ method: 'GET', url: '/api/v1/ns1/zones' });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance).toMatchObject({ source: 'ns1', mode: 'mock', synthetic: true, readOnly: true });
    expect(Array.isArray(res.json().zones)).toBe(true);
    await app.close();
  });

  it('returns a normalised record (answer ids present) and the raw record (unknown fields kept)', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const norm = await app.inject({ method: 'GET', url: RECORD_PATH });
    expect(norm.statusCode).toBe(200);
    const record = norm.json().record;
    expect(record.domain).toBe('live.rte.ie');
    expect(record.answers.map((a: { id: string }) => a.id)).toEqual(['ans-realta', 'ans-fastly', 'ans-akamai', 'ans-cloudfront']);

    const raw = await app.inject({ method: 'GET', url: `${RECORD_PATH}/raw` });
    expect(raw.json().raw._radar_note).toMatch(/SYNTHETIC/);
    await app.close();
  });

  it('maps an unknown record to a 404 NS1_NOT_FOUND', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({ method: 'GET', url: '/api/v1/ns1/zones/rte.ie/unknown.rte.ie/A' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NS1_NOT_FOUND');
    await app.close();
  });
});

describe('DNS explain — evaluation contract', () => {
  it('returns a filter-by-filter evaluation with identity, traces and provenance', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({ method: 'POST', url: '/api/v1/dns/explain', payload: explainBody });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provenance).toMatchObject({ mode: 'mock', synthetic: true });
    expect(body.request.scenario).toMatchObject({ qname: 'live.rte.ie', qtype: 'A', country: 'IE', asn: 5466 });
    const ev = body.evaluation;
    expect(ev.identity.source).toBe('ecs'); // ECS present and record honours it
    expect(ev.answers).toHaveLength(4);
    expect(ev.traces.map((t: { type: string }) => t.type)).toEqual([
      'up',
      'geotarget_country',
      'netfence_asn',
      'netfence_prefix',
      'weighted_shuffle',
      'select_first_n',
    ]);
    expect(typeof ev.complete).toBe('boolean');
    expect(Array.isArray(ev.eligibleAnswerIds)).toBe(true);
    await app.close();
  });

  it('reports a PARTIAL evaluation with no definitive completeness for a record with an unsupported filter', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dns/explain',
      payload: { ...explainBody, domain: 'vod.rte.ie' },
    });
    expect(res.statusCode).toBe(200);
    const ev = res.json().evaluation;
    expect(ev.complete).toBe(false);
    expect(ev.unsupportedFilters).toContain('sticky_shuffle');
    await app.close();
  });

  it('validates the request body (400 on a missing scenario field)', async () => {
    const app = await makeApp('VIEWING_ENGINEER');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dns/explain',
      payload: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', scenario: { ecsPresent: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_REQUEST');
    await app.close();
  });
});

describe('NS1 routes — safe upstream error mapping', () => {
  const throwing = (err: Ns1Error): Ns1ReadClient => ({
    listZones: async () => Promise.reject(err),
    getZone: async () => Promise.reject(err),
    getRecord: async () => Promise.reject(err),
    getActivity: async () => Promise.reject(err),
  });

  it('maps NS1_AUTH to 502 (never surfaces an upstream 401) and leaks nothing', async () => {
    const app = await makeApp('VIEWING_ENGINEER', { ns1Client: throwing(new Ns1Error('NS1_AUTH', undefined, { status: 401 })) });
    const res = await app.inject({ method: 'GET', url: '/api/v1/ns1/zones' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('NS1_AUTH');
    // The upstream 401 must not be surfaced. Assert on the structured fields — NOT the whole
    // payload, whose correlationId is a random UUID that can itself contain the substring "401".
    expect(res.json().message).not.toContain('401');
    expect(res.json()).not.toHaveProperty('status');
    expect(res.json()).not.toHaveProperty('upstreamStatus');
    await app.close();
  });

  it('maps NS1_UPSTREAM_TIMEOUT to 504', async () => {
    const app = await makeApp('VIEWING_ENGINEER', {
      ns1Client: throwing(new Ns1Error('NS1_UPSTREAM_TIMEOUT', undefined, { transient: true })),
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/dns/explain', payload: explainBody });
    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe('NS1_UPSTREAM_TIMEOUT');
    await app.close();
  });
});

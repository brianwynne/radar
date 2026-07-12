// Read-only NS1 validation routes: RBAC, run/results/unsupported-features, raw gating,
// invalid-target rejection, and the read-only guarantees (no write route; no secret leak).
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createValidationService } from '../src/validation/index.js';
import { MockNs1ReadClient, type Ns1ReadClient } from '../src/ns1/index.js';
import type { NewValidationResult, ValidationResultRecord, ValidationResultRepository } from '@radar/data';

const NOW = Date.parse('2026-07-12T12:00:00Z');

function fakeRepo() {
  const rows: ValidationResultRecord[] = [];
  const repo: ValidationResultRepository = {
    async create(v: NewValidationResult) {
      const rec = { ...v, id: `val-${rows.length + 1}`, ranAt: v.ranAt ?? new Date(NOW) } as ValidationResultRecord;
      rows.push(rec);
      return rec;
    },
    async getById(id) { return rows.find((r) => r.id === id) ?? null; },
    async list(q) {
      let out = [...rows].reverse();
      if (q?.overallStatus) out = out.filter((r) => r.overallStatus === q.overallStatus);
      return out.slice(0, q?.limit ?? 100);
    },
  };
  return { repo, rows };
}

async function app(role: string, opts: { client?: Ns1ReadClient; mode?: 'mock' | 'live'; liveEnabled?: boolean; withService?: boolean; withRepo?: boolean; auth?: boolean } = {}) {
  const { repo, rows } = fakeRepo();
  const service = createValidationService({ client: opts.client ?? new MockNs1ReadClient(), mode: opts.mode ?? 'mock', config: { liveValidationEnabled: opts.liveEnabled ?? false }, repository: repo, now: () => NOW });
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(opts.auth ?? true), RADAR_DEV_ROLE: role }), {
    validationService: (opts.withService ?? true) ? service : undefined,
    validationRepository: (opts.withRepo ?? true) ? repo : undefined,
  });
  await a.ready();
  return { a, rows };
}

describe('POST /api/v1/validation/ns1/run', () => {
  it('requires validation.run — NOC denied; Viewing Engineer runs read-only and persists', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A' } })).statusCode).toBe(403);
    await noc.a.close();

    const { a, rows } = await app('VIEWING_ENGINEER');
    const res = await a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A', includeRaw: true } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.provenance.notice).toMatch(/read-only.*not modified NS1/i);
    expect(b.results[0].endpoint).toBe('record');
    expect(b.results[0].sanitisedSample).toBeDefined(); // VE holds ns1.raw.read
    expect(b.results[0].fixtureCandidate.provenance.warning).toMatch(/CANDIDATE ONLY/);
    expect(rows).toHaveLength(1);
    await a.close();
  });

  it('rejects an invalid target / extra fields (strict) and 401 unauthenticated', async () => {
    const { a } = await app('VIEWING_ENGINEER');
    expect((await a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: {} })).statusCode).toBe(400); // zone required
    expect((await a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie', upstreamUrl: 'http://evil' } })).statusCode).toBe(400); // no arbitrary fields
    await a.close();
    const anon = await app('VIEWING_ENGINEER', { auth: false });
    expect((await anon.a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie' } })).statusCode).toBe(401);
    await anon.a.close();
  });

  it('blocks live validation unless enabled (409)', async () => {
    const blocked = await app('VIEWING_ENGINEER', { mode: 'live', liveEnabled: false });
    expect((await blocked.a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie' } })).statusCode).toBe(409);
    await blocked.a.close();
  });

  it('exposes no write route (telemetry/validation never mutates NS1)', async () => {
    const { a } = await app('ENGINEER');
    for (const url of ['/api/v1/validation/ns1/results', '/api/v1/validation/ns1/unsupported-features']) {
      for (const method of ['POST', 'PUT', 'DELETE'] as const) {
        expect((await a.inject({ method, url })).statusCode).toBe(404);
      }
    }
    await a.close();
  });
});

describe('GET /api/v1/validation/ns1/results', () => {
  it('lists results (ns1.detail.read) without the sanitised sample; single result gates raw on ns1.raw.read', async () => {
    const { a } = await app('VIEWING_ENGINEER');
    const run = (await a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A' } })).json();
    void run;
    const list = (await a.inject({ url: '/api/v1/validation/ns1/results' })).json();
    expect(list.count).toBe(1);
    expect(list.items[0].sanitisedSample).toBeUndefined(); // never in list view
    const id = (await a.inject({ url: '/api/v1/validation/ns1/results' })).json().items[0].id;
    const detail = (await a.inject({ url: `/api/v1/validation/ns1/results/${id}` })).json();
    expect(detail.item.sanitisedSample).toBeDefined(); // VE has ns1.raw.read
    expect((await a.inject({ url: '/api/v1/validation/ns1/results/nope' })).statusCode).toBe(404);
    await a.close();
  });

  it('is denied to a NOC viewer (403)', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.a.inject({ url: '/api/v1/validation/ns1/results' })).statusCode).toBe(403);
    await noc.a.close();
  });
});

describe('GET /api/v1/validation/ns1/unsupported-features', () => {
  it('aggregates unsupported filters across results', async () => {
    const client: Ns1ReadClient = { listZones: async () => [], getZone: async () => ({}), getRecord: async () => ({ domain: 'live.rte.ie', type: 'A', answers: [{ id: 'a', answer: ['1.2.3.4'] }], filters: [{ filter: 'up' }, { filter: 'shed_load' }] }), getActivity: async () => [] };
    const { a } = await app('VIEWING_ENGINEER', { client });
    await a.inject({ method: 'POST', url: '/api/v1/validation/ns1/run', payload: { zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A' } });
    const inv = (await a.inject({ url: '/api/v1/validation/ns1/unsupported-features' })).json();
    expect(inv.unsupportedFilters.find((f: { name: string }) => f.name === 'shed_load').count).toBe(1);
    await a.close();
  });
});

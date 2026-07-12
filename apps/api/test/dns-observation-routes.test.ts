// Read-only DNS-observation routes: RBAC, config/state/run/history, bounded history, and the
// read-only guarantees (manual run gated on dns.observed.run; no write to NS1/Cloudflare).
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDnsObservationService } from '../src/dns-observation/index.js';
import { loadDnsObservationConfig } from '../src/dns-observation/config.js';
import type { Ns1ReadClient } from '../src/ns1/index.js';
import type { DnsObservationRecord, DnsObservationRepository, NewDnsObservation } from '@radar/data';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const RECORD = {
  domain: 'live.rte.ie', type: 'A', ttl: 30, use_client_subnet: true,
  answers: [{ id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: true, weight: 70 } }, { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, weight: 30 } }],
  filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }],
};
const ns1: Ns1ReadClient = { listZones: async () => [], getZone: async () => ({}), getRecord: async () => RECORD, getActivity: async () => [] };

function fakeRepo() {
  const rows: DnsObservationRecord[] = [];
  const repo: DnsObservationRepository = {
    async create(o: NewDnsObservation) {
      const rec = { ...o, id: `obs-${rows.length + 1}`, observedAt: o.observedAt ?? new Date(NOW) } as DnsObservationRecord;
      rows.push(rec);
      return rec;
    },
    async list(q) {
      let out = [...rows].reverse();
      if (q?.ispId) out = out.filter((r) => r.ispId === q.ispId);
      if (q?.comparisonStatus) out = out.filter((r) => r.comparisonStatus === q.comparisonStatus);
      return out.slice(0, q?.limit ?? 100);
    },
    async latestPerIsp() {
      const seen = new Map<string, DnsObservationRecord>();
      for (const r of rows) seen.set(r.ispId, r);
      return [...seen.values()];
    },
  };
  return { repo, rows };
}

async function app(role: string, opts: { withService?: boolean; withRepo?: boolean; auth?: boolean } = {}): Promise<{ a: FastifyInstance; rows: DnsObservationRecord[] }> {
  const { repo, rows } = fakeRepo();
  const service = createDnsObservationService({ ns1Client: ns1, config: loadDnsObservationConfig({ DNS_OBSERVATION_MODE: 'mock' }), repository: repo, now: () => NOW });
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(opts.auth ?? true), RADAR_DEV_ROLE: role }), {
    dnsObservationService: (opts.withService ?? true) ? service : undefined,
    dnsObservationRepository: (opts.withRepo ?? true) ? repo : undefined,
    dnsObservationStaleAfterSeconds: 900,
  });
  await a.ready();
  return { a, rows };
}

describe('GET /api/v1/dns-observation/config', () => {
  it('returns scenarios, tier labels and vocabularies to a Viewing Engineer', async () => {
    const { a } = await app('VIEWING_ENGINEER');
    const res = await a.inject({ url: '/api/v1/dns-observation/config' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.mode).toBe('mock');
    expect(b.tierLabels).toMatchObject({ predicted: 'Predicted DNS steering', observed: 'Observed DNS answer' });
    expect(b.tierLabels.traffic).toMatch(/telemetry not connected/i);
    expect(b.scenarios.find((s: { ispId: string }) => s.ispId === 'vodafone')).toBeDefined();
    await a.close();
  });
  it('is denied to a NOC viewer (403) and unauthenticated (401)', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.a.inject({ url: '/api/v1/dns-observation/config' })).statusCode).toBe(403);
    await noc.a.close();
    const anon = await app('VIEWING_ENGINEER', { auth: false });
    expect((await anon.a.inject({ url: '/api/v1/dns-observation/config' })).statusCode).toBe(401);
    await anon.a.close();
  });
});

describe('POST /api/v1/dns-observation/run', () => {
  it('requires dns.observed.run — NOC denied, Viewing Engineer runs and persists', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.a.inject({ method: 'POST', url: '/api/v1/dns-observation/run', payload: { ispId: 'eir' } })).statusCode).toBe(403);
    await noc.a.close();

    const { a, rows } = await app('VIEWING_ENGINEER');
    const res = await a.inject({ method: 'POST', url: '/api/v1/dns-observation/run', payload: { ispId: 'eir' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.count).toBe(1);
    expect(b.results[0].comparisonStatus).toBe('match');
    expect(b.results[0].provenance.label).toBe('Observed DNS answer');
    expect(rows).toHaveLength(1);
    await a.close();
  });
  it('runs all scenarios when no ISP is given and 404s an unknown ISP', async () => {
    const { a } = await app('VIEWING_ENGINEER');
    expect((await a.inject({ method: 'POST', url: '/api/v1/dns-observation/run', payload: {} })).json().count).toBe(5);
    expect((await a.inject({ method: 'POST', url: '/api/v1/dns-observation/run', payload: { ispId: 'nope' } })).statusCode).toBe(404);
    await a.close();
  });
});

describe('GET /api/v1/dns-observation/state', () => {
  it('returns the latest observation per ISP after a run (observed tier, not traffic)', async () => {
    const { a } = await app('VIEWING_ENGINEER');
    await a.inject({ method: 'POST', url: '/api/v1/dns-observation/run', payload: { ispId: 'eir' } });
    const b = (await a.inject({ url: '/api/v1/dns-observation/state' })).json();
    expect(b.count).toBe(5); // one item per scenario
    const eir = b.items.find((i: { ispId: string }) => i.ispId === 'eir');
    expect(eir.observation.comparisonStatus).toBe('match');
    expect(b.items.find((i: { ispId: string }) => i.ispId === 'sky').observation).toBeNull(); // not yet observed
    await a.close();
  });
  it('is denied to a NOC viewer (403)', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.a.inject({ url: '/api/v1/dns-observation/state' })).statusCode).toBe(403);
    await noc.a.close();
  });
});

describe('GET /api/v1/dns-observation/history', () => {
  it('returns bounded history, filters, and rejects limit > 500 (400)', async () => {
    const { a } = await app('VIEWING_ENGINEER');
    await a.inject({ method: 'POST', url: '/api/v1/dns-observation/run', payload: {} }); // 5 observations
    expect((await a.inject({ url: '/api/v1/dns-observation/history' })).json().count).toBe(5);
    expect((await a.inject({ url: '/api/v1/dns-observation/history?isp=eir' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/dns-observation/history?limit=2' })).json().count).toBe(2);
    expect((await a.inject({ url: '/api/v1/dns-observation/history?limit=999' })).statusCode).toBe(400);
    await a.close();
  });
  it('503 when persistence is not configured', async () => {
    const { a } = await app('VIEWING_ENGINEER', { withRepo: false });
    expect((await a.inject({ url: '/api/v1/dns-observation/history' })).statusCode).toBe(503);
    await a.close();
  });
});

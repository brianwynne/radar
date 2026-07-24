// bgp.tools routes: RBAC, write-only Prometheus URL (never returned/echoed), monitored-prefix CRUD
// (mapping.manage), and the snapshot/incidents feeds. Driven through buildApp with the real
// repositories over pg-mem and a mock-mode connector.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newDb, type IMemoryDb } from 'pg-mem';
import {
  applyMigrations, loadMigrations,
  PostgresBgpToolsObservationRepository, PostgresBgpToolsIncidentRepository, PostgresBgpToolsMonitoredPrefixRepository,
  type ConnectorSettingsRecord, type ConnectorSettingsRepository, type ConnectorSettingsUpdate, type Queryable,
} from '@radar/data';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/security/secret-box.js';
import { BgpToolsConnectorManager } from '../src/bgptools/manager.js';
import { DEFAULT_THRESHOLDS } from '../src/bgptools/adapter.js';
import { MOCK_MONITORED_PREFIXES } from '../src/bgptools/fixtures.js';
import type { BgpToolsConfig } from '../src/bgptools/config.js';

const NOW = Date.parse('2026-07-24T12:00:00Z');
const PROM_URL = 'https://prometheus.bgp.tools/prom/route-secret-uuid';

class FakeConnRepo implements ConnectorSettingsRepository {
  row: ConnectorSettingsRecord | null = null;
  async get() { return this.row; }
  async upsert(u: ConnectorSettingsUpdate) {
    const p = this.row;
    const tok = u.tokenAction === 'replace' ? { tokenCiphertext: u.tokenCiphertext ?? null, tokenNonce: u.tokenNonce ?? null, tokenTag: u.tokenTag ?? null, tokenSetAt: new Date(NOW) }
      : u.tokenAction === 'clear' ? { tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenSetAt: null }
        : { tokenCiphertext: p?.tokenCiphertext ?? null, tokenNonce: p?.tokenNonce ?? null, tokenTag: p?.tokenTag ?? null, tokenSetAt: p?.tokenSetAt ?? null };
    this.row = { connector: u.connector, enabled: u.enabled, mode: u.mode, endpoint: u.endpoint, verifyTls: u.verifyTls, edgeDeviceIds: u.edgeDeviceIds, updatedBy: u.updatedBy, updatedAt: new Date(NOW), ...tok };
    return this.row;
  }
}

const cfg = (over: Partial<BgpToolsConfig> = {}): BgpToolsConfig => ({
  enabled: true, mode: 'mock', tableUrl: 'https://bgp.tools/table.jsonl', userAgent: 'RADAR bgp.tools - noc@rte.ie',
  prometheusUrl: undefined, tableEnabled: false, monitoredPrefixes: MOCK_MONITORED_PREFIXES, fullVisibilityHits: 100,
  thresholds: DEFAULT_THRESHOLDS, pollIntervalSeconds: 1800, retentionDays: 30, timeoutSeconds: 30, verifyTls: true, mockScenario: 'unexpected_origin', ...over,
});

async function freshDb(): Promise<Queryable> {
  const mem: IMemoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Queryable;
  await applyMigrations(db, loadMigrations());
  return db;
}

async function harness() {
  const db = await freshDb();
  const observations = new PostgresBgpToolsObservationRepository(db);
  const incidents = new PostgresBgpToolsIncidentRepository(db);
  const monitored = new PostgresBgpToolsMonitoredPrefixRepository(db);
  const manager = new BgpToolsConnectorManager({
    baseConfig: cfg(), repository: new FakeConnRepo(), secretBox: new SecretBox(Buffer.alloc(32, 7)),
    observations, incidents, loadMonitoredPrefixes: () => monitored.list(), now: () => NOW,
  });
  await manager.getPoller().poll(); // populate the snapshot + incidents
  return { manager, incidents, monitored };
}

async function app(role: string, h: Awaited<ReturnType<typeof harness>>, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }),
    { bgpToolsManager: h.manager, bgpToolsIncidents: h.incidents, bgpToolsMonitored: h.monitored });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('bgp.tools routes — RBAC + data', () => {
  it('NOC can read the snapshot; the mock hijack scenario is critical', async () => {
    const h = await harness();
    const a = await app('NOC_VIEWER', h);
    const res = await a.inject({ url: '/api/v1/routing/snapshot' });
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshot.overall).toBe('critical');
    expect(res.json().status.source).toBe('mock');
    await a.close();
  });

  it('resolves ASN owner names (feeds Routing Intelligence + BGP Intelligence); source carried', async () => {
    const h = await harness();
    // Inject a stub resolver — proves owners flow through. In production server.ts injects none, so
    // the route falls back to a live RIPEstat resolver (regression: it used to return empty owners).
    const resolver = { source: 'stub', resolve: async (asns: number[]) => new Map(asns.map((n) => [n, n === 174 ? 'Cogent Communications' : `Holder AS${n}`])) };
    const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'NOC_VIEWER' }),
      { bgpToolsManager: h.manager, bgpToolsIncidents: h.incidents, bgpToolsMonitored: h.monitored, asnResolver: resolver });
    await a.ready();
    const res = await a.inject({ url: '/api/v1/routing/asn-names?asns=174,1299' });
    expect(res.statusCode).toBe(200);
    expect(res.json().owners['174']).toBe('Cogent Communications');
    expect(res.json().source).toBe('stub');
    await a.close();
  });

  it('asn-names without an injected resolver still defaults (does not return empty by construction)', async () => {
    const h = await harness();
    // No asnResolver in deps (as in production). With no asns the default resolver is used but not
    // called — the key assertion is the route no longer short-circuits to source:'none' when a
    // resolver is absent. (asns omitted so no live network call is made.)
    const a = await app('NOC_VIEWER', h);
    const res = await a.inject({ url: '/api/v1/routing/asn-names' });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).not.toBe('none');
    await a.close();
  });

  it('connection management is Engineer-only', async () => {
    const h = await harness();
    const ve = await app('VIEWING_ENGINEER', h);
    expect((await ve.inject({ url: '/api/v1/routing/connection' })).statusCode).toBe(403);
    await ve.close();
    const eng = await app('ENGINEER', h);
    expect((await eng.inject({ url: '/api/v1/routing/connection' })).statusCode).toBe(200);
    await eng.close();
  });

  it('the Prometheus URL is write-only and never echoed', async () => {
    const h = await harness();
    const a = await app('ENGINEER', h);
    let body = (await a.inject({ url: '/api/v1/routing/connection' })).json();
    expect(body.settings.prometheusUrlConfigured).toBe(false);
    expect(JSON.stringify(body.settings)).not.toContain('route-secret-uuid');

    const put = await a.inject({ method: 'PUT', url: '/api/v1/routing/connection', payload: { enabled: true, mode: 'live', prometheusUrl: PROM_URL } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.prometheusUrlConfigured).toBe(true);
    expect(put.json().settings.prometheusHost).toBe('prometheus.bgp.tools');
    expect(put.body).not.toContain('route-secret-uuid'); // never in the response body

    body = (await a.inject({ url: '/api/v1/routing/connection' })).json();
    expect(body.settings).not.toHaveProperty('prometheusUrl');
    await a.close();
  });

  it('monitored-prefix CRUD requires mapping.manage', async () => {
    const h = await harness();
    const noc = await app('NOC_VIEWER', h);
    // NOC can list but not modify.
    expect((await noc.inject({ url: '/api/v1/routing/monitored' })).statusCode).toBe(200);
    expect((await noc.inject({ method: 'PUT', url: '/api/v1/routing/monitored', payload: { prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110 } })).statusCode).toBe(403);
    await noc.close();

    const eng = await app('ENGINEER', h);
    const put = await eng.inject({ method: 'PUT', url: '/api/v1/routing/monitored', payload: { prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110, description: 'test' } });
    expect(put.statusCode).toBe(200);
    expect((await eng.inject({ url: '/api/v1/routing/monitored' })).json().count).toBe(1);
    const del = await eng.inject({ method: 'DELETE', url: '/api/v1/routing/monitored', payload: { prefix: '203.0.113.0/24' } });
    expect(del.statusCode).toBe(200);
    expect((await eng.inject({ url: '/api/v1/routing/monitored' })).json().count).toBe(0);
    await eng.close();
  });

  it('exposes the open incidents from the poll', async () => {
    const h = await harness();
    const a = await app('NOC_VIEWER', h);
    const res = await a.inject({ url: '/api/v1/routing/incidents?openOnly=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((i: { kind: string }) => i.kind === 'hijack')).toBe(true);
    await a.close();
  });
});

// Stream Assurance routes: RBAC, profile create, and an audited diagnostic run that fetches two mock
// CDNs and persists findings — the incident classified through the full API path.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { StreamAssuranceService } from '../../src/stream-assurance/service.js';
import type { NewStreamAssuranceProfile, NewStreamAssuranceRun, StreamAssuranceProfileRow, StreamAssuranceRepository, StreamAssuranceRunRow } from '@radar/data';
import { buildInit } from './init-fixture.js';

const CURRENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OLD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

class FakeRepo implements StreamAssuranceRepository {
  profiles = new Map<string, StreamAssuranceProfileRow>();
  runs: NewStreamAssuranceRun[] = [];
  async upsertProfile(p: NewStreamAssuranceProfile) { this.profiles.set(p.id, { id: p.id, name: p.name, config: p.config, enabled: p.enabled ?? true, createdAt: new Date(), updatedAt: new Date() }); }
  async listProfiles() { return [...this.profiles.values()]; }
  async getProfile(id: string) { return this.profiles.get(id) ?? null; }
  async deleteProfile(id: string) { this.profiles.delete(id); }
  async insertRun(r: NewStreamAssuranceRun) { this.runs.push(r); }
  async latestRun(pid: string): Promise<StreamAssuranceRunRow | null> { const r = this.runs.filter((x) => x.profileId === pid).at(-1); return r ? (r as StreamAssuranceRunRow) : null; }
  async listRuns(pid: string) { return this.runs.filter((x) => x.profileId === pid) as StreamAssuranceRunRow[]; }
  async pruneRuns() { return 0; }
}

let server: http.Server; let port: number;
const audit = { record: vi.fn(async () => ({} as never)) };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const host = req.headers.host;
    if (host === 'live.rte.host') { res.writeHead(200, { 'x-cache': 'HIT', 'last-modified': 'Sun, 26 Jul 2026 12:00:00 GMT' }); res.end(buildInit(CURRENT)); }
    else { res.writeHead(200, { 'x-cache': 'TCP_MISS from edge', 'x-cache-remote': 'TCP_MISS from parent', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' }); res.end(buildInit(OLD)); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const repo = new FakeRepo();
const seedProfile = () => repo.upsertProfile({ id: 'rte-test', name: 'RTÉ Test', config: { endpoints: [
  { endpointId: 'fastly', provider: 'fastly', role: 'reference', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.host', managedInternal: true, originHost: 'live.rte.host' },
  { endpointId: 'akamai', provider: 'akamai', role: 'candidate', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.ie', managedInternal: true, originHost: 'live.rte.host' },
] } });

async function app(role: string, auth = true): Promise<FastifyInstance> {
  const service = new StreamAssuranceService(repo, { allowManagedInternal: true }, { now: () => Date.parse('2026-07-27T00:00:00Z') });
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    streamAssuranceRepository: repo, streamAssuranceService: service, database: { audit } as never,
  });
  await a.ready();
  return a;
}

describe('Stream Assurance routes', () => {
  it('serves the rule catalogue and lists profiles to a NOC viewer; blocks unauth', async () => {
    seedProfile();
    const noAuth = await app('NOC_VIEWER', false);
    expect((await noAuth.inject({ url: '/api/v1/stream-assurance/profiles' })).statusCode).toBe(401);
    await noAuth.close();

    const a = await app('NOC_VIEWER');
    const rules = await a.inject({ url: '/api/v1/stream-assurance/rules' });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().rules.find((r: { id: string }) => r.id === 'SA-CDN-001')).toBeDefined();
    const list = await a.inject({ url: '/api/v1/stream-assurance/profiles' });
    expect(list.json().profiles[0]).toMatchObject({ id: 'rte-test', endpointCount: 2 });
    await a.close();
  });

  it('enforces RBAC: configure needs Engineer, run needs Viewing Engineer', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles', payload: { id: 'x', name: 'x', config: { endpoints: [] } } })).statusCode).toBe(403);
    expect((await noc.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/run' })).statusCode).toBe(403);
    await noc.close();

    const eng = await app('ENGINEER');
    const created = await eng.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles', payload: { id: 'rte-two', name: 'RTÉ Two', config: { endpoints: [], tags: ['test'] } } });
    expect(created.statusCode).toBe(201);
    expect(repo.profiles.has('rte-two')).toBe(true);
    await eng.close();
  });

  it('a Viewing Engineer runs a profile: incident is classified, persisted and audited', async () => {
    seedProfile();
    audit.record.mockClear();
    const ve = await app('VIEWING_ENGINEER');
    const res = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/run' });
    expect(res.statusCode).toBe(200);
    const run = res.json().run;
    expect(run.status).toBe('findings');
    const f = run.findings.find((x: { endpointId: string }) => x.endpointId === 'akamai');
    expect(f.classification).toBe('ORIGIN_VARIANT_MISMATCH');
    expect(f.ruleId).toBe('SA-CDN-001');
    // Persisted + retrievable as the latest run.
    const latest = await ve.inject({ url: '/api/v1/stream-assurance/profiles/rte-test/latest' });
    expect(latest.json().run.findingCount).toBeGreaterThanOrEqual(1);
    // Audited.
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-assurance.run', outcome: 'success' }));
    await ve.close();

    // A non-existent profile → 404.
    const ve2 = await app('VIEWING_ENGINEER');
    expect((await ve2.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/nope/run' })).statusCode).toBe(404);
    await ve2.close();
  });
});

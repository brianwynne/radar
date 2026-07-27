// RIPE routes: RBAC (topology.summary.read) + the snapshot/events feeds through buildApp with a
// mock-backed RIPE service.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RipeService } from '../src/ripe/service.js';
import { loadRipeConfig } from '../src/ripe/config.js';
import { MockRipestatClient, type RipeScenario } from '../src/ripe/fixtures.js';
import type { NewRisEvent, RisConnectionChange, RisEventQuery, RisEventRecord, RisEventRepository } from '@radar/data';

class FakeHistory implements RisEventRepository {
  constructor(private readonly events: RisEventRecord[], private readonly conns: RisConnectionChange[]) {}
  async upsertBatch(_e: NewRisEvent[]): Promise<number> { return 0; }
  async range(q: RisEventQuery): Promise<RisEventRecord[]> {
    return this.events.filter((e) => e.lastAt >= q.since && e.lastAt <= (q.until ?? new Date()) && (!q.prefix || e.prefix === q.prefix) && (!q.kind || e.kind === q.kind)).slice(0, q.limit ?? 500);
  }
  async recordConnectionState(_c: RisConnectionChange): Promise<void> {}
  async connectionChanges(q: { since: Date; until?: Date }): Promise<RisConnectionChange[]> {
    return this.conns.filter((c) => c.at >= q.since && c.at <= (q.until ?? new Date()));
  }
  async prune(): Promise<number> { return 0; }
}

const NOW = Date.parse('2026-07-24T09:00:00Z');
const scenarioFor = (prefix: string): RipeScenario => (/89\.207\.57/.test(prefix) ? 'rpki_invalid' : 'healthy');

async function harness() {
  const config = loadRipeConfig({ RIPE_ENABLED: 'true', RIPE_RIS_LIVE_ENABLED: 'false' });
  const svc = new RipeService({ config, client: new MockRipestatClient({ scenarioFor, now: () => NOW }), now: () => NOW });
  await svc.poll();
  return svc;
}
async function app(role: string, svc: RipeService, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { ripeService: svc });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('RIPE routes', () => {
  it('NOC reads the snapshot; the RPKI-invalid /24 is critical, source live', async () => {
    const svc = await harness();
    const a = await app('NOC_VIEWER', svc);
    const res = await a.inject({ url: '/api/v1/ripe/snapshot' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshot.counts.total).toBe(5);
    expect(body.snapshot.counts.rpkiInvalid).toBe(1);
    expect(body.snapshot.overall).toBe('critical');
    expect(body.source.status).toBe('live');
    await a.close();
  });

  it('401 unauthenticated, 200 authenticated for events', async () => {
    const svc = await harness();
    const noAuth = await app('NOC_VIEWER', svc, false);
    expect((await noAuth.inject({ url: '/api/v1/ripe/events' })).statusCode).toBe(401);
    await noAuth.close();
    const a = await app('NOC_VIEWER', svc);
    const res = await a.inject({ url: '/api/v1/ripe/events' });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0); // RIS Live disabled → empty timeline
    await a.close();
  });

  it('serves persisted RIS event history over a look-back window, with connection-gap transitions', async () => {
    const svc = await harness();
    const recent: RisEventRecord = { id: 'a', kind: 'announcement', prefix: '89.207.56.0/21', originAsn: 41073, peerAsn: 174, path: [174, 41073], observationCount: 3, firstAt: new Date(NOW - 60_000), lastAt: new Date(NOW - 30_000) };
    const old: RisEventRecord = { id: 'old', kind: 'withdrawal', prefix: '89.207.57.0/24', originAsn: null, peerAsn: 3356, path: [], observationCount: 1, firstAt: new Date(NOW - 5 * 86_400_000), lastAt: new Date(NOW - 5 * 86_400_000) };
    const gap: RisConnectionChange = { at: new Date(NOW - 45_000), state: 'disconnected', detail: 'from connected' };
    const history = new FakeHistory([recent, old], [gap]);
    const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'NOC_VIEWER' }), { ripeService: svc, risEventRepository: history });
    await a.ready();

    // 1-hour window → only the recent event (the 5-day-old one is outside), plus the gap transition.
    const res = await a.inject({ url: `/api/v1/ripe/events/history?minutes=60&endMs=${NOW}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((e: RisEventRecord) => e.id)).toEqual(['a']);
    expect(body.connectionChanges).toHaveLength(1);
    expect(body.connectionChanges[0].state).toBe('disconnected');
    expect(body.retentionDays).toBe(90);
    expect(body.windowEndMs - body.windowStartMs).toBe(60 * 60_000);
    await a.close();
  });
});

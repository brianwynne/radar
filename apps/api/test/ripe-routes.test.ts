// RIPE routes: RBAC (topology.summary.read) + the snapshot/events feeds through buildApp with a
// mock-backed RIPE service.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RipeService } from '../src/ripe/service.js';
import { loadRipeConfig } from '../src/ripe/config.js';
import { MockRipestatClient, type RipeScenario } from '../src/ripe/fixtures.js';

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
});

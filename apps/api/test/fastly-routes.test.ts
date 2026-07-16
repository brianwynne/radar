// Read-only Fastly routes: RBAC, the informational provenance, and per-service telemetry. The
// poller is pre-populated from the mock client; no token appears in responses.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockFastlyClient } from '../src/fastly/mock-client.js';
import { FastlyPoller } from '../src/fastly/poller.js';

const NOW = Date.parse('2026-07-16T12:00:00Z');

async function poller(): Promise<FastlyPoller> {
  const p = new FastlyPoller({ client: new MockFastlyClient(() => NOW), enabled: true, intervalMs: 60_000, maxSampleAgeSeconds: 180, now: () => NOW });
  await p.runOnce();
  return p;
}

async function app(role: string, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    fastlyPoller: await poller(),
  });
  await a.ready();
  return a;
}

describe('Fastly routes', () => {
  it('401 when unauthenticated', async () => {
    const a = await app('NOC_VIEWER', false);
    expect((await a.inject({ url: '/api/v1/cdn/fastly/services' })).statusCode).toBe(401);
    await a.close();
  });

  it('a NOC viewer reads status and services', async () => {
    const a = await app('NOC_VIEWER');
    for (const path of ['status', 'services']) {
      expect((await a.inject({ url: `/api/v1/cdn/fastly/${path}` })).statusCode).toBe(200);
    }
    await a.close();
  });

  it('services carry per-service delivery telemetry; provenance is informational', async () => {
    const a = await app('NOC_VIEWER');
    const svcs = (await a.inject({ url: '/api/v1/cdn/fastly/services' })).json();
    expect(svcs.count).toBeGreaterThan(0);
    const vod = svcs.items.find((s: { serviceName: string }) => s.serviceName === 'RTÉ Player VOD');
    expect(vod.hitRatioPercent).toBeGreaterThan(0);
    expect(vod.requestsPerSecond).toBeGreaterThan(0);
    expect(svcs.provenance.informationalOnly).toBe(true);

    const status = (await a.inject({ url: '/api/v1/cdn/fastly/status' })).json();
    expect(status.status.serviceCount).toBeGreaterThan(0);
    expect(status.provenance.notice).toMatch(/MOCK|informational/i);
    expect(JSON.stringify(svcs) + JSON.stringify(status)).not.toMatch(/fastly-key/i);
    await a.close();
  });
});

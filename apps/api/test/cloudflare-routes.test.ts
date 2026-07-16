// Read-only Cloudflare routes: RBAC, the informational provenance, and that steering is resolved
// to pool names. The poller is pre-populated from the mock client; no token appears in responses.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockCloudflareClient } from '../src/cloudflare/mock-client.js';
import { CloudflarePoller } from '../src/cloudflare/poller.js';

const NOW = Date.parse('2026-07-16T12:00:00Z');

async function poller(): Promise<CloudflarePoller> {
  const p = new CloudflarePoller({ client: new MockCloudflareClient(() => NOW), enabled: true, intervalMs: 60_000, maxSampleAgeSeconds: 180, now: () => NOW });
  await p.runOnce();
  return p;
}

async function app(role: string, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    cloudflarePoller: await poller(),
  });
  await a.ready();
  return a;
}

describe('Cloudflare routes', () => {
  it('401 when unauthenticated', async () => {
    const a = await app('NOC_VIEWER', false);
    expect((await a.inject({ url: '/api/v1/network/cloudflare/pools' })).statusCode).toBe(401);
    await a.close();
  });

  it('a NOC viewer reads status, load-balancers and pools', async () => {
    const a = await app('NOC_VIEWER');
    for (const path of ['status', 'load-balancers', 'pools']) {
      expect((await a.inject({ url: `/api/v1/network/cloudflare/${path}` })).statusCode).toBe(200);
    }
    await a.close();
  });

  it('load balancers resolve steering to pool names; pools expose origins + health', async () => {
    const a = await app('NOC_VIEWER');
    const lbs = (await a.inject({ url: '/api/v1/network/cloudflare/load-balancers' })).json();
    const live = lbs.items.find((l: { name: string }) => l.name === 'liveedge.rte.ie');
    expect(live.steeringPolicy).toBe('random');
    expect(live.defaultPools.map((p: { poolName: string }) => p.poolName)).toContain('live-realta-citywest');

    const pools = (await a.inject({ url: '/api/v1/network/cloudflare/pools' })).json();
    const ctw = pools.items.find((p: { name: string }) => p.name === 'live-realta-citywest');
    expect(ctw.origins.length).toBe(4);
    expect(pools.provenance.informationalOnly).toBe(true);

    const status = (await a.inject({ url: '/api/v1/network/cloudflare/status' })).json();
    expect(status.status.poolCount).toBe(3);
    expect(status.provenance.notice).toMatch(/MOCK|informational/i);
    await a.close();
  });
});

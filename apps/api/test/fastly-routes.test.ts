// Read-only Fastly routes: RBAC, the informational provenance, and per-service telemetry. The
// poller is pre-populated from the mock client; no token appears in responses.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockFastlyClient } from '../src/fastly/mock-client.js';
import { FastlyPoller } from '../src/fastly/poller.js';
import { FastlyRealtimeStreamer } from '../src/fastly/realtime-streamer.js';
import type { FastlyRealtimeClient } from '../src/fastly/types.js';

const NOW = Date.parse('2026-07-16T12:00:00Z');
const NOW_SEC = Math.floor(NOW / 1000);

async function poller(): Promise<FastlyPoller> {
  const p = new FastlyPoller({ client: new MockFastlyClient(() => NOW), enabled: true, intervalMs: 60_000, maxSampleAgeSeconds: 180, now: () => NOW });
  await p.runOnce();
  return p;
}

// A streamer holding one live-tail second for the mock 'RTÉ Live' service id, so the route can be
// exercised end-to-end (and its name enrichment from the poller snapshot verified).
const LIVE_ID = 'SU9a8b7RTElive000000';
async function streamer(): Promise<FastlyRealtimeStreamer> {
  const client: FastlyRealtimeClient = {
    async pollChannel() {
      return { samples: [{ second: NOW_SEC, at: new Date(NOW).toISOString(), requests: 42, hits: 40, miss: 2, errors: 0, bandwidthBytes: 5_000, status2xx: 41, status3xx: 0, status4xx: 1, status5xx: 0 }], nextTimestamp: NOW_SEC, aggregateDelaySeconds: 5 };
    },
  };
  const s = new FastlyRealtimeStreamer({ client, services: [{ id: LIVE_ID, name: LIVE_ID }], enabled: true, windowSeconds: 120, source: 'fastly' }, { now: () => NOW });
  await s.pollServiceOnce(LIVE_ID);
  return s;
}

async function app(role: string, auth = true, withRealtime = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    fastlyPoller: await poller(),
    fastlyRealtimeStreamer: withRealtime ? await streamer() : undefined,
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

  it('a NOC viewer reads status, services and realtime', async () => {
    const a = await app('NOC_VIEWER');
    for (const path of ['status', 'services', 'realtime']) {
      expect((await a.inject({ url: `/api/v1/cdn/fastly/${path}` })).statusCode).toBe(200);
    }
    await a.close();
  });

  it('401 when unauthenticated on realtime', async () => {
    const a = await app('NOC_VIEWER', false);
    expect((await a.inject({ url: '/api/v1/cdn/fastly/realtime' })).statusCode).toBe(401);
    await a.close();
  });

  it('realtime returns per-second series, names enriched from the poller snapshot', async () => {
    const a = await app('NOC_VIEWER');
    const rt = (await a.inject({ url: '/api/v1/cdn/fastly/realtime' })).json();
    expect(rt.source).toBe('fastly');
    expect(rt.series).toHaveLength(1);
    const live = rt.series[0];
    expect(live.serviceId).toBe(LIVE_ID);
    expect(live.serviceName).toBe('RTÉ Live'); // enriched from the historical poller snapshot
    expect(live.latestRequestsPerSecond).toBe(42);
    expect(live.samples[0].bandwidthBytes).toBe(5_000);
    expect(rt.provenance.informationalOnly).toBe(true);

    // status carries the realtime block too.
    const status = (await a.inject({ url: '/api/v1/cdn/fastly/status' })).json();
    expect(status.realtime.services[0].serviceId).toBe(LIVE_ID);
    expect(status.realtime.enabled).toBe(true);
    await a.close();
  });

  it('realtime is honest when no streamer is wired: disabled, empty series', async () => {
    const a = await app('NOC_VIEWER', true, false);
    const rt = (await a.inject({ url: '/api/v1/cdn/fastly/realtime' })).json();
    expect(rt.source).toBe('disabled');
    expect(rt.series).toEqual([]);
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

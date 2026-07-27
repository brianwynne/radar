// Dashboard delivery route: RBAC + the live split (Réalta eyeball + commercial CDNs) with a 1-hour
// average, through buildApp with fake pollers/connectors and a fake delivery repo.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { NetworkStateSnapshot } from '../src/cloudvision/types.js';
import type { FastlySnapshot } from '../src/fastly/types.js';
import type { AkamaiSnapshot } from '../src/akamai/types.js';
import type { CloudVisionPoller } from '../src/cloudvision/poller.js';
import type { FastlyPoller } from '../src/fastly/poller.js';
import type { AkamaiConnector } from '../src/akamai/index.js';
import type { DeliverySampleRepository } from '@radar/data';

afterEach(() => vi.restoreAllMocks());

const net = { interfaces: [
  { memberOf: null, linkType: 'PRIVATE_PEERING', provider: 'Eir', name: '', outBps: 5e9 },
  { memberOf: null, linkType: 'PRIVATE_PEERING', provider: 'Sky', name: '', outBps: 4e9 },
] } as unknown as NetworkStateSnapshot;
const fastly = { services: [{ bandwidthBps: 1e9 }, { bandwidthBps: 5e8 }] } as unknown as FastlySnapshot;
const akamai = { series: [{ bandwidthBps: 1e9 }] } as unknown as AkamaiSnapshot;

const deps = {
  cloudVisionPoller: { getLatest: () => net } as unknown as CloudVisionPoller,
  fastlyPoller: { latestSnapshot: () => fastly } as unknown as FastlyPoller,
  akamaiConnector: {
    snapshot: () => akamai,
    status: () => ({ source: 'disabled', aggregator: null, s3: null, ingestEnabled: false }),
    ingestEnabled: () => false,
  } as unknown as AkamaiConnector,
  deliverySampleRepository: {
    averageSince: async () => ({ avgRealtaBps: 8e9, avgCommercialBps: 2e9, avgTotalBps: 10e9, sampleCount: 120 }),
    insert: async () => {}, prune: async () => 0,
  } as DeliverySampleRepository,
};

async function app(role: string, auth = true) {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), deps);
  await a.ready();
  return a;
}

describe('Dashboard delivery route', () => {
  it('401 unauthenticated; NOC gets the live split + 1-hour average', async () => {
    const noAuth = await app('NOC_VIEWER', false);
    expect((await noAuth.inject({ url: '/api/v1/dashboard/delivery' })).statusCode).toBe(401);
    await noAuth.close();

    const a = await app('NOC_VIEWER');
    const res = await a.inject({ url: '/api/v1/dashboard/delivery' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.live.realtaBps).toBe(9e9);
    expect(b.live.commercialBps).toBe(2.5e9);
    expect(b.live.totalBps).toBe(11.5e9);
    expect(b.live.slices[0].label).toBe('Eir'); // busiest eyeball first
    expect(b.live.slices.map((s: { label: string }) => s.label)).toContain('Fastly');
    expect(b.average.avgTotalBps).toBe(10e9);
    expect(b.average.sampleCount).toBe(120);
    expect(b.average.windowMinutes).toBe(60);
    await a.close();
  });
});

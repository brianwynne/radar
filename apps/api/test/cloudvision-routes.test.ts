// Read-only CloudVision network-telemetry routes: RBAC, role-aware detail, filtering,
// history, connector status, and the read-only/informational guarantees (no write route; no
// endpoint URL or token in responses). The poller is pre-populated from the mock client.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockCloudVisionClient } from '../src/cloudvision/mock-client.js';
import { CloudVisionPoller } from '../src/cloudvision/poller.js';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from '../src/cloudvision/classification-rules.js';
import { MOCK_EDGE_DEVICE_IDS, type ScenarioName } from '../src/cloudvision/fixtures.js';
import type { PniBandwidthGap, PniBandwidthPoint, PniBandwidthRepository } from '@radar/data';

const NOW = Date.parse('2026-07-15T12:00:00Z');

// A stub PNI history store: `range` returns fixed points so we can assert the endpoint's grouping
// and bucket-scaling without a database.
function fakePniRepo(points: PniBandwidthPoint[], gaps: PniBandwidthGap[] = [], seen?: { minGapSeconds?: number }): PniBandwidthRepository {
  return {
    insertBatch: async () => 0,
    prune: async () => 0,
    range: async () => points,
    gaps: async (q) => { if (seen) seen.minGapSeconds = q.minGapSeconds; return gaps; },
  };
}

async function poller(scenario: ScenarioName = 'normal'): Promise<CloudVisionPoller> {
  const client = new MockCloudVisionClient({
    scenario, staleAfterSeconds: 30, expectedDeviceIds: MOCK_EDGE_DEVICE_IDS, classificationRules: DEFAULT_CLASSIFICATION_RULES,
    providerForAsn: DEFAULT_PROVIDER_FOR_ASN, warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound', now: () => NOW,
  });
  const p = new CloudVisionPoller({ client, source: 'mock', intervalMs: 10_000, now: () => NOW });
  await p.runOnce();
  return p;
}

async function app(role: string, opts: { poller?: CloudVisionPoller; auth?: boolean; pniHistory?: PniBandwidthRepository } = {}): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(opts.auth ?? true), RADAR_DEV_ROLE: role }), {
    cloudVisionPoller: opts.poller ?? (await poller()),
    cloudVisionMode: 'mock',
    pniBandwidthRepository: opts.pniHistory,
  });
  await a.ready();
  return a;
}

describe('CloudVision network-telemetry routes', () => {
  it('401 when unauthenticated', async () => {
    const a = await app('NOC_VIEWER', { auth: false });
    expect((await a.inject({ url: '/api/v1/network/interfaces' })).statusCode).toBe(401);
    await a.close();
  });

  it('a NOC viewer reads status, devices, interfaces, link-groups, bgp-peers, history', async () => {
    const a = await app('NOC_VIEWER');
    for (const path of ['status', 'devices', 'interfaces', 'link-groups', 'bgp-peers', 'history']) {
      expect((await a.inject({ url: `/api/v1/network/${path}` })).statusCode).toBe(200);
    }
    await a.close();
  });

  it('interfaces: NOC gets core fields, VE gets engineering detail', async () => {
    const noc = await app('NOC_VIEWER');
    const nocEir = (await noc.inject({ url: '/api/v1/network/interfaces?provider=Eir' })).json().items[0];
    expect(nocEir).toMatchObject({ provider: 'Eir', linkType: 'PRIVATE_PEERING', bandwidthSource: 'REPORTED' });
    expect(nocEir.utilisationPercent).toBeCloseTo(40, 5);
    expect(nocEir.classificationSource).toBeUndefined(); // gated
    expect(nocEir.warnings).toBeUndefined();
    await noc.close();

    const ve = await app('VIEWING_ENGINEER');
    const veEir = (await ve.inject({ url: '/api/v1/network/interfaces?provider=Eir' })).json().items[0];
    expect(veEir.classificationSource).toBe('description_regex');
    expect(Array.isArray(veEir.warnings)).toBe(true);
    await ve.close();
  });

  it('filters interfaces by linkType, deviceId and unknownOnly', async () => {
    const a = await app('NOC_VIEWER');
    expect((await a.inject({ url: '/api/v1/network/interfaces?linkType=TRANSIT' })).json().count).toBe(2);
    expect((await a.inject({ url: '/api/v1/network/interfaces?deviceId=JPE00000001' })).json().count).toBe(5);
    expect((await a.inject({ url: '/api/v1/network/interfaces?unknownOnly=true' })).json().count).toBe(0);
    await a.close();
  });

  it('link-group utilisation is total/total and provider cards aggregate', async () => {
    const a = await app('NOC_VIEWER');
    const groups = (await a.inject({ url: '/api/v1/network/link-groups' })).json().items;
    const eir = groups.find((g: { key: string }) => g.key === 'eir');
    // edge1 40G + edge2 38G = 78G over 200G capacity = 39%.
    expect(eir.currentBps).toBe(78e9);
    expect(eir.utilisationPercent).toBeCloseTo(39, 5);
    await a.close();
  });

  it('bgp-peers filter by established/state (bgp-failure scenario)', async () => {
    const a = await app('NOC_VIEWER', { poller: await poller('bgp-failure') });
    expect((await a.inject({ url: '/api/v1/network/bgp-peers?established=false' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/network/bgp-peers?state=ACTIVE' })).json().count).toBe(1);
    await a.close();
  });

  it('status reports the connector state and snapshot summary', async () => {
    const a = await app('NOC_VIEWER');
    const b = (await a.inject({ url: '/api/v1/network/status' })).json();
    expect(b.status).toMatchObject({ enabled: true, source: 'mock', deviceCount: 2 });
    expect(b.summary.totalPeeringThroughputBps).toBeGreaterThan(0);
    expect(b.provenance.notice).toMatch(/informational/i);
    await a.close();
  });

  it('history returns time-series points and honours limit', async () => {
    const a = await app('NOC_VIEWER');
    const all = (await a.inject({ url: '/api/v1/network/history' })).json();
    expect(all.count).toBe(1);
    expect(all.items[0]).toHaveProperty('totalEdgeThroughputBps');
    expect((await a.inject({ url: '/api/v1/network/history?limit=1' })).json().count).toBe(1);
    await a.close();
  });

  it('never returns the endpoint URL, token or authorization header', async () => {
    const a = await app('VIEWING_ENGINEER');
    for (const path of ['status', 'devices', 'interfaces', 'bgp-peers']) {
      const raw = (await a.inject({ url: `/api/v1/network/${path}` })).body.toLowerCase();
      expect(raw).not.toContain('bearer');
      expect(raw).not.toContain('authorization');
      expect(raw).not.toMatch(/https?:\/\//);
    }
    await a.close();
  });

  it('a disabled connector (no poller) reports enabled:false and empty collections', async () => {
    const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'NOC_VIEWER' }), { cloudVisionMode: 'disabled' });
    await a.ready();
    expect((await a.inject({ url: '/api/v1/network/status' })).json().status.enabled).toBe(false);
    expect((await a.inject({ url: '/api/v1/network/devices' })).json().count).toBe(0);
    await a.close();
  });

  describe('pni-history', () => {
    const at = new Date('2026-07-15T12:00:00Z');
    const base = { linkType: 'PRIVATE_PEERING', datacentre: 'Citywest' };
    const points: PniBandwidthPoint[] = [
      { deviceId: 'D1', interfaceName: 'Ethernet1', provider: 'Eir', ...base, at, inBps: 1e6, outBps: 2e6 },
      { deviceId: 'D1', interfaceName: 'Ethernet1', provider: 'Eir', ...base, at: new Date(at.getTime() + 60_000), inBps: 1.5e6, outBps: 2.5e6 },
      { deviceId: 'D1', interfaceName: 'Ethernet2', provider: 'Sky', ...base, at, inBps: 3e6, outBps: 4e6 },
    ];

    it('groups points into one series per PNI and scales the bucket to the range', async () => {
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo(points) });
      const res = (await a.inject({ url: '/api/v1/network/pni-history?minutes=60' })).json();
      expect(res.rangeMinutes).toBe(60);
      expect(res.bucketSeconds).toBe(10); // 3600s / 360 target points
      expect(res.series).toHaveLength(2);
      const eth1 = res.series.find((s: { interfaceName: string }) => s.interfaceName === 'Ethernet1');
      expect(eth1.provider).toBe('Eir');
      expect(eth1.linkType).toBe('PRIVATE_PEERING'); // classification carried for eyeball identification
      expect(eth1.datacentre).toBe('Citywest');
      expect(eth1.points).toHaveLength(2);
      expect(eth1.points[0]).toEqual({ at: at.toISOString(), inBps: 1e6, outBps: 2e6 });
      await a.close();
    });

    it('defaults to 60 minutes and scales the bucket up for a 24h range', async () => {
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo([]) });
      expect((await a.inject({ url: '/api/v1/network/pni-history' })).json().rangeMinutes).toBe(60);
      expect((await a.inject({ url: '/api/v1/network/pni-history?minutes=1440' })).json().bucketSeconds).toBe(240); // 86400 / 360
      await a.close();
    });

    it('returns an empty series when no history store is configured', async () => {
      const a = await app('NOC_VIEWER'); // no pniHistory
      const res = (await a.inject({ url: '/api/v1/network/pni-history?minutes=60' })).json();
      expect(res.series).toEqual([]);
      expect(res.bucketSeconds).toBe(0);
      await a.close();
    });

    it('rejects an out-of-range minutes value', async () => {
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo([]) });
      expect((await a.inject({ url: '/api/v1/network/pni-history?minutes=99999' })).statusCode).toBe(400);
      await a.close();
    });

    it('carries link classification from whichever bucket has it (null-safe grouping)', async () => {
      const at = new Date('2026-07-15T12:00:00Z');
      const pts: PniBandwidthPoint[] = [
        // Earliest bucket predates classification (nulls); a later bucket has it.
        { deviceId: 'D1', interfaceName: 'Ethernet1', provider: 'Eir', linkType: null, datacentre: null, at, inBps: 1e6, outBps: 2e6 },
        { deviceId: 'D1', interfaceName: 'Ethernet1', provider: 'Eir', linkType: 'PRIVATE_PEERING', datacentre: 'Citywest', at: new Date(at.getTime() + 60_000), inBps: 1e6, outBps: 2e6 },
      ];
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo(pts) });
      const s = (await a.inject({ url: '/api/v1/network/pni-history?minutes=60' })).json().series[0];
      expect(s.linkType).toBe('PRIVATE_PEERING');
      expect(s.datacentre).toBe('Citywest');
      await a.close();
    });

    it('reports the SAME recording gaps at every range (they are not derived from the display bucket)', async () => {
      // The regression: gap detection used to run on the bucketed points with a threshold of 2.5
      // buckets, so a ~5-minute outage showed at 6h (60s buckets) and vanished at 24h (240s buckets).
      const from = new Date('2026-07-15T12:30:00Z');
      const to = new Date('2026-07-15T12:35:00Z'); // 5 min — under the old 24h threshold of 10 min
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo(points, [{ from, to }]) });
      const six = (await a.inject({ url: '/api/v1/network/pni-history?minutes=360' })).json();
      const day = (await a.inject({ url: '/api/v1/network/pni-history?minutes=1440' })).json();
      const expected = [{ fromMs: from.getTime(), toMs: to.getTime() }];
      expect(six.outages).toEqual(expected);
      expect(day.outages).toEqual(expected);
      expect(six.bucketSeconds).not.toBe(day.bucketSeconds); // buckets differ; the verdict does not
      await a.close();
    });

    it('derives the gap threshold from the poll cadence, with a floor', async () => {
      const seen: { minGapSeconds?: number } = {};
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo([], [], seen), poller: await poller() });
      const res = (await a.inject({ url: '/api/v1/network/pni-history?minutes=60' })).json();
      expect(seen.minGapSeconds).toBe(90); // 10s poll × 6 → below the 90s floor, so the floor wins
      expect(res.gapSeconds).toBe(90);
      await a.close();
    });

    it('reports no gaps and a zero threshold when no history store is configured', async () => {
      const a = await app('NOC_VIEWER'); // no pniHistory
      const res = (await a.inject({ url: '/api/v1/network/pni-history?minutes=60' })).json();
      expect(res.outages).toEqual([]);
      expect(res.gapSeconds).toBe(0);
      await a.close();
    });

    it('windows on endMs (paused pan / day selection) and clamps it to the last 7 days', async () => {
      const a = await app('NOC_VIEWER', { pniHistory: fakePniRepo([]) });
      // A window ending 2 days ago is within the 7-day retained horizon → used verbatim.
      const twoDaysAgo = Date.now() - 2 * 24 * 3600_000;
      const r1 = (await a.inject({ url: `/api/v1/network/pni-history?minutes=1440&endMs=${twoDaysAgo}` })).json();
      expect(r1.windowEndMs).toBe(twoDaysAgo);
      expect(r1.windowStartMs).toBe(twoDaysAgo - 1440 * 60_000);
      // A window older than 7 days is clamped up to ~now−7d.
      const wayBack = Date.now() - 8 * 24 * 3600_000;
      const r2 = (await a.inject({ url: `/api/v1/network/pni-history?minutes=1440&endMs=${wayBack}` })).json();
      expect(r2.windowEndMs).toBeGreaterThan(wayBack);
      expect(Math.abs(Date.now() - 7 * 24 * 3600_000 - r2.windowEndMs)).toBeLessThan(5000);
      await a.close();
    });
  });
});

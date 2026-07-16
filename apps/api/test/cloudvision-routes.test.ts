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

const NOW = Date.parse('2026-07-15T12:00:00Z');

async function poller(scenario: ScenarioName = 'normal'): Promise<CloudVisionPoller> {
  const client = new MockCloudVisionClient({
    scenario, staleAfterSeconds: 30, expectedDeviceIds: MOCK_EDGE_DEVICE_IDS, classificationRules: DEFAULT_CLASSIFICATION_RULES,
    providerForAsn: DEFAULT_PROVIDER_FOR_ASN, warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound', now: () => NOW,
  });
  const p = new CloudVisionPoller({ client, source: 'mock', intervalMs: 10_000, now: () => NOW });
  await p.runOnce();
  return p;
}

async function app(role: string, opts: { poller?: CloudVisionPoller; auth?: boolean } = {}): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(opts.auth ?? true), RADAR_DEV_ROLE: role }), {
    cloudVisionPoller: opts.poller ?? (await poller()),
    cloudVisionMode: 'mock',
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
});

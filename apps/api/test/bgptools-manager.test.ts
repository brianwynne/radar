// bgp.tools connector manager: mock⇄live, encrypted Prometheus-URL storage that is NEVER returned
// or logged, master-key guard, and test-connection. Uses a real SecretBox with a test key and an
// in-memory connector-settings repo.
import { describe, it, expect } from 'vitest';
import type {
  BgpToolsIncidentRepository, BgpToolsObservationRepository,
  ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate,
} from '@radar/data';
import { SecretBox } from '../src/security/secret-box.js';
import { BgpToolsConnectorManager, BgpToolsManagerError, type BgpToolsManagerDeps } from '../src/bgptools/manager.js';
import { DEFAULT_THRESHOLDS } from '../src/bgptools/adapter.js';
import { MOCK_MONITORED_PREFIXES } from '../src/bgptools/fixtures.js';
import type { BgpToolsConfig } from '../src/bgptools/config.js';

const URL_SECRET = 'https://prometheus.bgp.tools/prom/18f91be7-secret-uuid';
const box = new SecretBox(Buffer.alloc(32, 7));

class FakeConnRepo implements ConnectorSettingsRepository {
  row: ConnectorSettingsRecord | null = null;
  async get() { return this.row; }
  async upsert(u: ConnectorSettingsUpdate) {
    const prev = this.row;
    const tok = u.tokenAction === 'replace'
      ? { tokenCiphertext: u.tokenCiphertext ?? null, tokenNonce: u.tokenNonce ?? null, tokenTag: u.tokenTag ?? null, tokenSetAt: new Date() }
      : u.tokenAction === 'clear'
        ? { tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenSetAt: null }
        : { tokenCiphertext: prev?.tokenCiphertext ?? null, tokenNonce: prev?.tokenNonce ?? null, tokenTag: prev?.tokenTag ?? null, tokenSetAt: prev?.tokenSetAt ?? null };
    this.row = { connector: u.connector, enabled: u.enabled, mode: u.mode, endpoint: u.endpoint, verifyTls: u.verifyTls, edgeDeviceIds: u.edgeDeviceIds, updatedBy: u.updatedBy, updatedAt: new Date(), ...tok };
    return this.row;
  }
}

const noopObs: BgpToolsObservationRepository = { record: async () => ({ record: {} as never, inserted: false }), list: async () => [], prune: async () => 0 };
const noopInc: BgpToolsIncidentRepository = { openOrUpdate: async () => ({} as never), resolveOpen: async () => null, list: async () => [] };

function baseConfig(over: Partial<BgpToolsConfig> = {}): BgpToolsConfig {
  return {
    enabled: true, mode: 'live', tableUrl: 'https://bgp.tools/table.jsonl', userAgent: 'RADAR bgp.tools - noc@rte.ie',
    prometheusUrl: undefined, tableEnabled: false, monitoredPrefixes: [], fullVisibilityHits: 100,
    thresholds: DEFAULT_THRESHOLDS, pollIntervalSeconds: 1800, retentionDays: 30, timeoutSeconds: 30, verifyTls: true, mockScenario: undefined,
    ...over,
  };
}

function manager(over: Partial<BgpToolsManagerDeps> = {}, cfg?: BgpToolsConfig) {
  return new BgpToolsConnectorManager({ baseConfig: cfg ?? baseConfig(), repository: new FakeConnRepo(), secretBox: box, observations: noopObs, incidents: noopInc, ...over });
}

describe('BgpToolsConnectorManager', () => {
  it('stores the Prometheus URL encrypted and never returns it', async () => {
    const repo = new FakeConnRepo();
    const m = manager({ repository: repo });
    expect(m.view().prometheusUrlConfigured).toBe(false);
    expect(m.view().degraded).toMatch(/no prometheus/i);

    const view = await m.updateSettings({ prometheusUrl: URL_SECRET }, { subject: 'eng-1' });
    expect(view.prometheusUrlConfigured).toBe(true);
    expect(view.prometheusHost).toBe('prometheus.bgp.tools');
    expect(view.source).toBe('database');
    expect(view.degraded).toBeNull();
    // The secret never appears in the view.
    expect(JSON.stringify(view)).not.toContain('secret-uuid');
    // Stored as ciphertext that round-trips only via the box.
    expect(repo.row?.tokenCiphertext).toBeInstanceOf(Buffer);
    expect(repo.row!.tokenCiphertext!.toString('utf8')).not.toContain('secret-uuid');
    expect(box.open({ ciphertext: repo.row!.tokenCiphertext!, nonce: repo.row!.tokenNonce!, tag: repo.row!.tokenTag! })).toBe(URL_SECRET);
  });

  it('refuses to store a URL without the master key', async () => {
    const m = manager({ secretBox: null });
    await expect(m.updateSettings({ prometheusUrl: URL_SECRET }, {})).rejects.toMatchObject({ code: 'MASTER_KEY_UNAVAILABLE' });
    expect(BgpToolsManagerError).toBeDefined();
  });

  it('rejects a non-URL value', async () => {
    const m = manager();
    await expect(m.updateSettings({ prometheusUrl: 'not-a-url' }, {})).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('test() pings the live Prometheus client and never leaks the URL', async () => {
    const body = 'bgptools_asn_prefix_visible{asn="41073",prefix="89.207.56.0/21"} 2673\n';
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const m = manager({ fetchImpl }, baseConfig({ prometheusUrl: URL_SECRET }));
    const r = await m.test();
    expect(r.ok).toBe(true);
    expect(r.source).toBe('bgptools');
    expect(JSON.stringify(r)).not.toContain('secret-uuid');
  });

  it('mock mode drives the poller through the mock client', async () => {
    const m = manager({}, baseConfig({ mode: 'mock', monitoredPrefixes: MOCK_MONITORED_PREFIXES, mockScenario: 'unexpected_origin' }));
    const snap = await m.getPoller().poll();
    expect(snap.source).toBe('mock');
    expect(snap.overall).toBe('critical'); // the hijack scenario
  });

  it('clearing removes the stored URL', async () => {
    const m = manager();
    await m.updateSettings({ prometheusUrl: URL_SECRET }, { subject: 'eng' });
    const view = await m.updateSettings({ clearPrometheusUrl: true }, { subject: 'eng' });
    expect(view.prometheusUrlConfigured).toBe(false);
  });

  it('User-Agent can be set via updateSettings and unblocks live mode', async () => {
    // Live + a URL but NO User-Agent → the Prometheus client can't build (bgp.tools blocks it).
    const m = manager({}, baseConfig({ userAgent: '', prometheusUrl: URL_SECRET }));
    expect(m.view().userAgentValid).toBe(false);
    expect(m.view().degraded).toMatch(/User-Agent/i);
    // Setting an identifying UA with a contact email clears the block.
    const view = await m.updateSettings({ userAgent: 'RADAR bgp.tools - noc@rte.ie' }, { subject: 'eng' });
    expect(view.userAgent).toBe('RADAR bgp.tools - noc@rte.ie');
    expect(view.userAgentValid).toBe(true);
    expect(view.degraded).toBeNull();
  });

  it('disabled connector → test reports an error', async () => {
    const m = manager({}, baseConfig({ enabled: false }));
    expect((await m.test()).ok).toBe(false);
  });
});

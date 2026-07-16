// Fastly connector manager: encrypted token round-trip via the shared connector-settings repo,
// fail-closed when the master key is absent, the token never leaving via getSettingsView, and
// testConnection mapping an auth failure. No real Fastly is contacted (injected fetch).
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { FastlyConnectorManager } from '../src/fastly/manager.js';
import { ConnectorManagerError } from '../src/cloudvision/manager.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { FastlyConfig } from '../src/fastly/config.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const TOKEN = 'fastly-MANAGER-SECRET-99';
const NOW = Date.parse('2026-07-16T12:00:00Z');

const baseConfig: FastlyConfig = {
  enabled: false, mode: 'mock', apiBase: 'https://api.fastly.com', serviceIds: [], windowMinutes: 10,
  timeoutSeconds: 15, pollIntervalSeconds: 60, maxSampleAgeSeconds: 180, retryAttempts: 1,
};

class FakeRepo implements ConnectorSettingsRepository {
  row: ConnectorSettingsRecord | null = null;
  async get() { return this.row; }
  async upsert(u: ConnectorSettingsUpdate) {
    const p = this.row;
    let ct = p?.tokenCiphertext ?? null, nn = p?.tokenNonce ?? null, tg = p?.tokenTag ?? null, at = p?.tokenSetAt ?? null;
    if (u.tokenAction === 'replace') { ct = u.tokenCiphertext ?? null; nn = u.tokenNonce ?? null; tg = u.tokenTag ?? null; at = new Date(NOW); }
    else if (u.tokenAction === 'clear') { ct = null; nn = null; tg = null; at = null; }
    this.row = { connector: u.connector, enabled: u.enabled, mode: u.mode, endpoint: u.endpoint, verifyTls: u.verifyTls, edgeDeviceIds: u.edgeDeviceIds, tokenCiphertext: ct, tokenNonce: nn, tokenTag: tg, tokenSetAt: at, updatedBy: u.updatedBy, updatedAt: new Date(NOW) };
    return this.row;
  }
}

/** Canned Fastly transport: `/service` returns two services unless the token is bad (403). */
function cannedFetch(opts: { authFails?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const p = String(input);
    if (opts.authFails) return new Response('forbidden', { status: 403 });
    if (p.includes('/service')) return new Response(JSON.stringify([{ id: 'svc-a', name: 'A' }, { id: 'svc-b', name: 'B' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (p.includes('/stats/service/')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

function makeManager(opts: { secretBox?: SecretBox | null; fetchImpl?: typeof fetch } = {}) {
  const auditEvents: Record<string, unknown>[] = [];
  const manager = new FastlyConnectorManager({
    baseConfig, repository: new FakeRepo(),
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); return undefined; } },
    isDevelopment: false, now: () => NOW, fetchImpl: opts.fetchImpl ?? cannedFetch(),
  });
  return { manager, auditEvents };
}

describe('FastlyConnectorManager', () => {
  it('round-trips an encrypted token; getSettingsView never exposes it', async () => {
    const { manager, auditEvents } = makeManager();
    await manager.init();

    let view = manager.getSettingsView();
    expect(view.tokenConfigured).toBe(false);

    view = await manager.updateSettings({ enabled: true, mode: 'live', apiBase: 'https://api.fastly.com', serviceIds: ['svc-a'], token: TOKEN }, { subject: 'eng@rte.ie', roles: ['ENGINEER'] });
    expect(view.tokenConfigured).toBe(true);
    expect(view.serviceIds).toEqual(['svc-a']);
    expect(view.source).toBe('database');
    // The token appears nowhere in the view or the audit trail.
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(auditEvents)).not.toContain(TOKEN);
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', resourceKey: 'fastly', details: { tokenAction: 'replace' } });

    manager.stop();
  });

  it('retains the stored token when the token field is blank, and clears on request', async () => {
    const { manager } = makeManager();
    await manager.init();
    await manager.updateSettings({ enabled: true, mode: 'live', token: TOKEN }, { subject: 'eng@rte.ie' });
    // Retain: change service ids, omit token.
    let view = await manager.updateSettings({ serviceIds: ['svc-a', 'svc-b'] }, { subject: 'eng@rte.ie' });
    expect(view.tokenConfigured).toBe(true);
    expect(view.serviceIds).toEqual(['svc-a', 'svc-b']);
    // Clear.
    view = await manager.updateSettings({ enabled: false, clearToken: true }, { subject: 'eng@rte.ie' });
    expect(view.tokenConfigured).toBe(false);
    manager.stop();
  });

  it('fails closed: storing a token with no master key throws and persists nothing', async () => {
    const { manager } = makeManager({ secretBox: null });
    await manager.init();
    await expect(manager.updateSettings({ enabled: true, mode: 'live', token: TOKEN }, { subject: 'eng@rte.ie' }))
      .rejects.toThrow(ConnectorManagerError);
    expect(manager.getSettingsView().tokenConfigured).toBe(false);
    expect(manager.getSettingsView().masterKeyAvailable).toBe(false);
    manager.stop();
  });

  it('live mode requires a token that exists after the update', async () => {
    const { manager } = makeManager();
    await manager.init();
    await expect(manager.updateSettings({ enabled: true, mode: 'live' }, { subject: 'eng@rte.ie' }))
      .rejects.toMatchObject({ code: 'TOKEN_REQUIRED' });
    manager.stop();
  });

  it('testConnection succeeds against a live service list and maps a 403 to an auth error', async () => {
    const okMgr = makeManager().manager;
    await okMgr.init();
    await okMgr.updateSettings({ enabled: true, mode: 'live', token: TOKEN }, { subject: 'eng@rte.ie' });
    const good = await okMgr.test('cid');
    expect(good.ok).toBe(true);
    expect(good.summary?.services).toBe(2);
    okMgr.stop();

    const badMgr = makeManager({ fetchImpl: cannedFetch({ authFails: true }) }).manager;
    await badMgr.init();
    await badMgr.updateSettings({ enabled: true, mode: 'live', token: TOKEN }, { subject: 'eng@rte.ie' });
    const bad = await badMgr.test('cid');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('FASTLY_AUTH');
    badMgr.stop();
  });
});

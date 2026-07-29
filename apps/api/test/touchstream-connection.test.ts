import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/security/secret-box.js';
import { TouchstreamConnectorManager } from '../src/touchstream/manager.js';
import { loadTouchstreamConfig } from '../src/touchstream/config.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const APP_ID = 'app-id-abc123';
const TOKEN = 'bearer-token-xyz789';

/** In-memory connector_settings store with the real retain/replace/clear semantics. */
function fakeRepo(): ConnectorSettingsRepository & { row: ConnectorSettingsRecord | null } {
  const store: { row: ConnectorSettingsRecord | null } = { row: null };
  return {
    get row() {
      return store.row;
    },
    async get() {
      return store.row;
    },
    async upsert(u: ConnectorSettingsUpdate) {
      const prev = store.row;
      const keep = u.tokenAction === 'retain';
      store.row = {
        connector: u.connector,
        enabled: u.enabled,
        mode: u.mode,
        endpoint: u.endpoint,
        verifyTls: u.verifyTls,
        edgeDeviceIds: u.edgeDeviceIds,
        tokenCiphertext: keep ? (prev?.tokenCiphertext ?? null) : u.tokenAction === 'clear' ? null : (u.tokenCiphertext ?? null),
        tokenNonce: keep ? (prev?.tokenNonce ?? null) : u.tokenAction === 'clear' ? null : (u.tokenNonce ?? null),
        tokenTag: keep ? (prev?.tokenTag ?? null) : u.tokenAction === 'clear' ? null : (u.tokenTag ?? null),
        tokenSetAt: u.tokenAction === 'replace' ? new Date('2026-07-29T21:00:00Z') : keep ? (prev?.tokenSetAt ?? null) : null,
        updatedBy: u.updatedBy,
        updatedAt: new Date('2026-07-29T21:00:00Z'),
      };
      return store.row;
    },
  };
}

const base = loadTouchstreamConfig({});
const box = () => new SecretBox(randomBytes(32));

async function manager(
  opts: { secretBox?: SecretBox | null; audit?: { record: (e: Record<string, unknown>) => Promise<unknown> }; fetchImpl?: typeof fetch } = {},
) {
  const repo = fakeRepo();
  const m = new TouchstreamConnectorManager({
    baseConfig: base,
    repository: repo,
    secretBox: opts.secretBox === undefined ? box() : opts.secretBox,
    audit: opts.audit as never,
    // Injected so no test ever touches the network.
    fetchImpl: opts.fetchImpl,
  });
  await m.init();
  return { m, repo };
}

describe('Touchstream connector manager', () => {
  it('stores both credentials encrypted and never returns either', async () => {
    const { m, repo } = await manager();
    const view = await m.updateSettings(
      { enabled: true, mode: 'live', endpoint: 'https://ts.example.net', appId: APP_ID, token: TOKEN },
      'eng@rte.ie',
    );
    expect(view.appIdConfigured).toBe(true);
    expect(view.tokenConfigured).toBe(true);
    // Neither half appears anywhere in the view…
    const serialisedView = JSON.stringify(view);
    expect(serialisedView).not.toContain(APP_ID);
    expect(serialisedView).not.toContain(TOKEN);
    // …nor in the persisted row in plaintext (the app id is encrypted too, deliberately).
    const serialisedRow = JSON.stringify(repo.row);
    expect(serialisedRow).not.toContain(APP_ID);
    expect(serialisedRow).not.toContain(TOKEN);
    expect(repo.row!.tokenCiphertext).not.toBeNull();
    // The spare text column carries only the non-secret environment selector.
    expect(repo.row!.edgeDeviceIds).toBe('PROD');
  });

  it('refuses half a credential rather than storing something unusable', async () => {
    const { m } = await manager();
    await expect(m.updateSettings({ mode: 'live', appId: APP_ID }, 'eng')).rejects.toMatchObject({ code: 'TOUCHSTREAM_AUTH' });
    await expect(m.updateSettings({ mode: 'live', token: TOKEN }, 'eng')).rejects.toThrow(/BOTH/);
  });

  it('retains the stored pair when both fields are left blank', async () => {
    const { m, repo } = await manager();
    await m.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://ts.example.net', appId: APP_ID, token: TOKEN }, 'eng');
    const before = repo.row!.tokenCiphertext;
    const view = await m.updateSettings({ enabled: false }, 'eng');
    expect(repo.row!.tokenCiphertext).toEqual(before);
    expect(view.tokenConfigured).toBe(true);
    expect(view.enabled).toBe(false);
  });

  it('ignores a masked placeholder instead of storing the mask', async () => {
    const { m, repo } = await manager();
    await m.updateSettings({ mode: 'live', endpoint: 'https://x', appId: APP_ID, token: TOKEN }, 'eng');
    const before = repo.row!.tokenCiphertext;
    await m.updateSettings({ appId: '••••••••', token: '••••••••' }, 'eng');
    expect(repo.row!.tokenCiphertext).toEqual(before);
  });

  it('clears the pair on request', async () => {
    const { m, repo } = await manager();
    await m.updateSettings({ mode: 'live', endpoint: 'https://x', appId: APP_ID, token: TOKEN }, 'eng');
    const view = await m.updateSettings({ clearCredentials: true }, 'eng');
    expect(repo.row!.tokenCiphertext).toBeNull();
    expect(view.tokenConfigured).toBe(false);
  });

  it('fails closed with no master key rather than storing plaintext', async () => {
    const { m, repo } = await manager({ secretBox: null });
    await expect(m.updateSettings({ mode: 'live', appId: APP_ID, token: TOKEN }, 'eng')).rejects.toThrow(/master key/);
    expect(repo.row).toBeNull();
    expect(m.view().masterKeyAvailable).toBe(false);
  });

  it('reports degraded — not healthy — when a stored credential cannot be decrypted', async () => {
    const { m, repo } = await manager();
    await m.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://x', appId: APP_ID, token: TOKEN }, 'eng');
    // A different master key stands in for a rotated or lost one.
    const other = new TouchstreamConnectorManager({ baseConfig: base, repository: repo, secretBox: box() });
    await other.init();
    const view = other.view();
    expect(view.degraded).toMatch(/could not be decrypted/);
    expect(view.tokenConfigured).toBe(false);
    // And it must not be polling live with no usable credential.
    expect(other.getPoller().status().enabled).toBe(false);
  });

  it('will not enable live polling with the endpoint or a credential missing', async () => {
    const { m } = await manager();
    await m.updateSettings({ enabled: true, mode: 'live', endpoint: null }, 'eng');
    expect(m.getPoller().status().enabled).toBe(false);
    expect(m.view().degraded).toMatch(/BOTH credentials/);
  });

  it('audits a credential change without recording the secret', async () => {
    const events: Record<string, unknown>[] = [];
    const { m } = await manager({ audit: { record: async (e) => void events.push(e) } });
    await m.updateSettings({ mode: 'live', endpoint: 'https://x', appId: APP_ID, token: TOKEN }, 'eng@rte.ie');
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('connector.touchstream.credential.replace');
    expect(events[0].actorSubject).toBe('eng@rte.ie');
    const raw = JSON.stringify(events);
    expect(raw).not.toContain(APP_ID);
    expect(raw).not.toContain(TOKEN);
  });

  it('runs the poller in mock mode with no credentials at all', async () => {
    const { m } = await manager();
    await m.updateSettings({ enabled: true, mode: 'mock' }, 'eng');
    expect(m.getPoller().status().enabled).toBe(true);
    await m.getPoller().runOnce();
    expect(m.getPoller().snapshot()!.summary.monitorCount).toBeGreaterThan(0);
    const test = await m.test();
    expect(test.ok).toBe(true);
    expect(test.monitorCount).toBeGreaterThan(0);
  });

  it('reports a failed test without leaking the credential', async () => {
    const { m } = await manager({ fetchImpl: async () => new Response('', { status: 403 }) });
    await m.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://x', appId: APP_ID, token: TOKEN }, 'eng');
    const result = await m.test();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

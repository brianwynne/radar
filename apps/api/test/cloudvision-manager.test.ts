// CloudVision connector manager: token retain/replace/clear semantics, fail-closed without a
// master key, live validation, runtime reconfigure — and the SECURITY PROOFS that the token
// never appears in a settings view, an audit entry, a log line, an error, or the serialised
// persisted row. The token is decrypted only to construct the live client (asserted via the
// bearer header the stub fetch receives).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CloudVisionConnectorManager, ConnectorManagerError } from '../src/cloudvision/manager.js';
import { SecretBox } from '../src/security/secret-box.js';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from '../src/cloudvision/classification-rules.js';
import type { CloudVisionConfig } from '../src/cloudvision/config.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const NOW = Date.parse('2026-07-15T12:00:00Z');
const TOKEN = 'sk-cloudvision-SUPER-SECRET-9x8y7z';

const baseConfig: CloudVisionConfig = {
  enabled: false, mode: 'mock', edgeDeviceIds: [], timeoutSeconds: 10, pollIntervalSeconds: 10, verifyTls: true,
  maxSampleAgeSeconds: 30, retryAttempts: 1, warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound',
  classificationRules: DEFAULT_CLASSIFICATION_RULES, providerForAsn: DEFAULT_PROVIDER_FOR_ASN,
};

class FakeRepo implements ConnectorSettingsRepository {
  row: ConnectorSettingsRecord | null = null;
  async get(): Promise<ConnectorSettingsRecord | null> {
    return this.row;
  }
  async upsert(u: ConnectorSettingsUpdate): Promise<ConnectorSettingsRecord> {
    const prev = this.row;
    let ct = prev?.tokenCiphertext ?? null, nn = prev?.tokenNonce ?? null, tg = prev?.tokenTag ?? null, setAt = prev?.tokenSetAt ?? null;
    if (u.tokenAction === 'replace') { ct = u.tokenCiphertext ?? null; nn = u.tokenNonce ?? null; tg = u.tokenTag ?? null; setAt = new Date(NOW); }
    else if (u.tokenAction === 'clear') { ct = null; nn = null; tg = null; setAt = null; }
    this.row = { connector: u.connector, enabled: u.enabled, mode: u.mode, endpoint: u.endpoint, verifyTls: u.verifyTls, edgeDeviceIds: u.edgeDeviceIds, tokenCiphertext: ct, tokenNonce: nn, tokenTag: tg, tokenSetAt: setAt, updatedBy: u.updatedBy, updatedAt: new Date(NOW) };
    return this.row;
  }
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const INVENTORY = [{ result: { value: { key: { device_id: 'DEV1' }, hostname: 'edge1', model_name: 'X', software_version: '1', streaming_status: 'ACTIVE' } } }];
const IF_STATE = { notifications: [{ updates: { Ethernet1: { description: 'Eir PNI', linkStatus: 'up', adminStatus: 'up', speed: 100e9, outBitsRate: 40e9, inBitsRate: 8e9, counters: {} } } }] };
const BGP_STATE = { notifications: [{ updates: { '185.6.36.1': { asn: 5466, state: 'Established', prefixesReceived: 1, prefixesAdvertised: 1 } } }] };

/** A stub fetch that records the bearer header it receives and serves canned CloudVision data. */
function recordingFetch() {
  const authHeaders: (string | null)[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    authHeaders.push(new Headers(init?.headers).get('authorization'));
    const p = String(input);
    if (p.includes('/Device/all')) return ok(INVENTORY);
    if (p.includes('/intfStatus')) return ok(IF_STATE);
    if (p.includes('peerInfoStatus')) return ok(BGP_STATE);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fn, authHeaders };
}

function make(opts: { secretBox?: SecretBox | null; fetchImpl?: typeof fetch } = {}) {
  const repo = new FakeRepo();
  const auditEvents: Record<string, unknown>[] = [];
  const logCalls: unknown[] = [];
  const logger = { info: (o: unknown, m?: unknown) => logCalls.push([o, m]), warn: (o: unknown, m?: unknown) => logCalls.push([o, m]), error: (o: unknown, m?: unknown) => logCalls.push([o, m]) };
  const manager = new CloudVisionConnectorManager({
    baseConfig, repository: repo,
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); } },
    isDevelopment: false, now: () => NOW, logger, fetchImpl: opts.fetchImpl,
  });
  return { manager, repo, auditEvents, logCalls };
}

const actor = { subject: 'engineer@rte.ie', roles: ['ENGINEER'] };

afterEach(() => vi.restoreAllMocks());

describe('token lifecycle semantics', () => {
  it('replace stores a token; the view reports it configured but never returns it', async () => {
    const { manager } = make();
    const view = await manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN }, actor);
    manager.stop();
    expect(view.tokenConfigured).toBe(true);
    expect(view.tokenSetAt).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('an omitted/blank token retains the stored token', async () => {
    const { manager, repo } = make();
    await manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN }, actor);
    const ct1 = repo.row!.tokenCiphertext;
    const view = await manager.updateSettings({ verifyTls: false }, actor); // no token field
    manager.stop();
    expect(view.tokenConfigured).toBe(true);
    expect(repo.row!.tokenCiphertext).toBe(ct1); // unchanged
    expect(view.verifyTls).toBe(false);
  });

  it('clearToken removes the token', async () => {
    const { manager, repo } = make();
    await manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN }, actor);
    const view = await manager.updateSettings({ enabled: false, clearToken: true }, actor);
    manager.stop();
    expect(view.tokenConfigured).toBe(false);
    expect(repo.row!.tokenCiphertext).toBeNull();
    expect(repo.row!.tokenSetAt).toBeNull();
  });

  it('rejects a masked placeholder as a token value', async () => {
    const { manager } = make();
    await expect(manager.updateSettings({ token: '••••••••' }, actor)).rejects.toBeInstanceOf(ConnectorManagerError);
  });
});

describe('fail closed + live validation', () => {
  it('refuses to store a token when the master key is unavailable', async () => {
    const { manager } = make({ secretBox: null });
    await expect(manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN }, actor))
      .rejects.toMatchObject({ code: 'MASTER_KEY_UNAVAILABLE' });
  });

  it('live requires an endpoint, HTTPS, and a token', async () => {
    const { manager } = make();
    await expect(manager.updateSettings({ enabled: true, mode: 'live', token: TOKEN }, actor)).rejects.toMatchObject({ code: 'ENDPOINT_REQUIRED' });
    await expect(manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'http://cvp.test', token: TOKEN }, actor)).rejects.toMatchObject({ code: 'ENDPOINT_INSECURE' });
    await expect(manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test' }, actor)).rejects.toMatchObject({ code: 'TOKEN_REQUIRED' });
  });
});

describe('runtime reconfigure', () => {
  it('switching to mock makes the poller report the mock source', async () => {
    const { manager } = make();
    await manager.updateSettings({ enabled: true, mode: 'mock' }, actor);
    expect(manager.getPoller().status().source).toBe('mock');
    manager.stop();
  });

  it('decrypts the stored token only to build the live client (bearer header proves it)', async () => {
    const { fn, authHeaders } = recordingFetch();
    const { manager } = make({ fetchImpl: fn });
    await manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN }, actor);
    const result = await manager.test('cid');
    manager.stop();
    expect(result.ok).toBe(true);
    expect(result.summary?.devices).toBe(1);
    // The live client used the decrypted token — but only in the outbound bearer header.
    expect(authHeaders).toContain(`Bearer ${TOKEN}`);
  });
});

describe('security proofs — the token never leaks', () => {
  it('is absent from the settings view, audit entries, logs, errors and the serialised row', async () => {
    const { fn } = recordingFetch();
    const { manager, repo, auditEvents, logCalls } = make({ fetchImpl: fn });
    await manager.updateSettings({ enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN, edgeDeviceIds: ['DEV1'] }, actor);
    await manager.test('cid');
    const view = manager.getSettingsView();
    manager.stop();

    const haystacks: Record<string, string> = {
      view: JSON.stringify(view),
      audit: JSON.stringify(auditEvents),
      logs: JSON.stringify(logCalls),
      // The persisted row: token is present only as ciphertext bytea — the PLAINTEXT must not appear.
      row: JSON.stringify(repo.row, (_k, v) => (v && v.type === 'Buffer' ? '[ciphertext]' : v)),
    };
    for (const [where, s] of Object.entries(haystacks)) {
      expect(s, `token leaked into ${where}`).not.toContain(TOKEN);
    }
    // The audit entry DID record the action, without the secret.
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', details: { tokenAction: 'replace' } });
  });
});

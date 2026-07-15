// Engineer-managed CloudVision connection routes: RBAC (connector.manage), write-only token
// semantics (retain/replace/clear), masked-placeholder rejection, fail-closed without a
// master key, and the proof the token never appears in a response or audit entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CloudVisionConnectorManager } from '../src/cloudvision/manager.js';
import { SecretBox } from '../src/security/secret-box.js';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from '../src/cloudvision/classification-rules.js';
import type { CloudVisionConfig } from '../src/cloudvision/config.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const TOKEN = 'sk-cloudvision-ROUTE-SECRET-42';
const NOW = Date.parse('2026-07-15T12:00:00Z');

const baseConfig: CloudVisionConfig = {
  enabled: false, mode: 'mock', edgeDeviceIds: [], timeoutSeconds: 10, pollIntervalSeconds: 10, verifyTls: true,
  maxSampleAgeSeconds: 30, retryAttempts: 1, warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound',
  classificationRules: DEFAULT_CLASSIFICATION_RULES, providerForAsn: DEFAULT_PROVIDER_FOR_ASN,
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

const cannedFetch = (async (input: RequestInfo | URL) => {
  const p = String(input);
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  if (p.includes('/Device/all')) return ok([{ result: { value: { key: { device_id: 'DEV1' }, hostname: 'e1', streaming_status: 'ACTIVE' } } }]);
  if (p.includes('/intfStatus')) return ok({ notifications: [{ updates: { Ethernet1: { description: 'Eir PNI', linkStatus: 'up', adminStatus: 'up', speed: 100e9, outBitsRate: 40e9 } } }] });
  if (p.includes('peerInfoStatus')) return ok({ notifications: [{ updates: {} }] });
  return new Response('', { status: 404 });
}) as typeof fetch;

function makeManager(opts: { secretBox?: SecretBox | null } = {}) {
  const auditEvents: Record<string, unknown>[] = [];
  const manager = new CloudVisionConnectorManager({
    baseConfig, repository: new FakeRepo(),
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); return undefined; } },
    isDevelopment: false, now: () => NOW, fetchImpl: cannedFetch,
  });
  return { manager, auditEvents };
}

async function app(role: string, manager?: CloudVisionConnectorManager, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { cloudVisionManager: manager });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('RBAC', () => {
  it('403 for a Viewing Engineer, 200 for an Engineer', async () => {
    const { manager } = makeManager();
    const ve = await app('VIEWING_ENGINEER', manager);
    expect((await ve.inject({ url: '/api/v1/network/connection' })).statusCode).toBe(403);
    await ve.close();
    const eng = await app('ENGINEER', manager);
    expect((await eng.inject({ url: '/api/v1/network/connection' })).statusCode).toBe(200);
    manager.stop();
    await eng.close();
  });

  it('401 when unauthenticated', async () => {
    const { manager } = makeManager();
    const a = await app('ENGINEER', manager, false);
    expect((await a.inject({ url: '/api/v1/network/connection' })).statusCode).toBe(401);
    await a.close();
  });
});

describe('token write-only semantics', () => {
  it('GET never returns the token; PUT replace/retain/clear behave correctly', async () => {
    const { manager } = makeManager();
    const a = await app('ENGINEER', manager);

    let body = (await a.inject({ url: '/api/v1/network/connection' })).json();
    expect(body.settings.tokenConfigured).toBe(false);
    expect(body.settings).not.toHaveProperty('token');

    // Replace.
    const put = await a.inject({ method: 'PUT', url: '/api/v1/network/connection', payload: { enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.tokenConfigured).toBe(true);
    expect(put.body).not.toContain(TOKEN);

    // Retain (no token field).
    await a.inject({ method: 'PUT', url: '/api/v1/network/connection', payload: { verifyTls: false } });
    body = (await a.inject({ url: '/api/v1/network/connection' })).json();
    expect(body.settings.tokenConfigured).toBe(true);
    expect(body.settings.verifyTls).toBe(false);

    // Clear.
    await a.inject({ method: 'PUT', url: '/api/v1/network/connection', payload: { enabled: false, clearToken: true } });
    expect((await a.inject({ url: '/api/v1/network/connection' })).json().settings.tokenConfigured).toBe(false);

    manager.stop();
    await a.close();
  });

  it('rejects a masked placeholder as a token value', async () => {
    const { manager } = makeManager();
    const a = await app('ENGINEER', manager);
    const res = await a.inject({ method: 'PUT', url: '/api/v1/network/connection', payload: { token: '••••••••' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOKEN_VALUE');
    manager.stop();
    await a.close();
  });
});

describe('fail closed', () => {
  it('409 when storing a token with no master key', async () => {
    const { manager } = makeManager({ secretBox: null });
    const a = await app('ENGINEER', manager);
    const res = await a.inject({ method: 'PUT', url: '/api/v1/network/connection', payload: { enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MASTER_KEY_UNAVAILABLE');
    await a.close();
  });
});

describe('security proof — token never in responses or audit', () => {
  it('after setting a token, it appears in no response body or audit entry', async () => {
    const { manager, auditEvents } = makeManager();
    const a = await app('ENGINEER', manager);
    await a.inject({ method: 'PUT', url: '/api/v1/network/connection', payload: { enabled: true, mode: 'live', endpoint: 'https://cvp.test', token: TOKEN } });

    const get = await a.inject({ url: '/api/v1/network/connection' });
    const test = await a.inject({ method: 'POST', url: '/api/v1/network/connection/test' });
    for (const raw of [get.body, test.body, JSON.stringify(auditEvents)]) {
      expect(raw).not.toContain(TOKEN);
    }
    // The test hit the live endpoint successfully (proving the token was used internally).
    expect(test.json().result.ok).toBe(true);
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', details: { tokenAction: 'replace' } });

    manager.stop();
    await a.close();
  });
});

describe('unconfigured', () => {
  it('503 when no manager is wired', async () => {
    const a = await app('ENGINEER', undefined);
    expect((await a.inject({ url: '/api/v1/network/connection' })).statusCode).toBe(503);
    await a.close();
  });
});

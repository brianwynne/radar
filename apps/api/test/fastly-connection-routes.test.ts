// Engineer-managed Fastly connection routes: RBAC (connector.manage), write-only token semantics
// (retain/replace/clear), fail-closed without a master key, that PUT reconfigures the live poller,
// and the proof the token never appears in a response or audit entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FastlyConnectorManager } from '../src/fastly/manager.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { FastlyConfig } from '../src/fastly/config.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const TOKEN = 'fastly-ROUTE-SECRET-42';
const NOW = Date.parse('2026-07-16T12:00:00Z');

const baseConfig: FastlyConfig = {
  enabled: false, mode: 'mock', apiBase: 'https://api.fastly.com', serviceIds: [], windowMinutes: 10,
  timeoutSeconds: 15, pollIntervalSeconds: 60, maxSampleAgeSeconds: 180, retryAttempts: 1,
  realtimeApiBase: 'https://rt.fastly.com', realtimeEnabled: false, realtimeWindowSeconds: 120, realtimeRequestTimeoutSeconds: 30,
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
  if (p.includes('/stats/service/')) return new Response(JSON.stringify({ data: [{ requests: 100, hits: 90, miss: 10, bandwidth: 1000, origin_fetches: 8, status_2xx: 98, status_3xx: 0, status_4xx: 1, status_5xx: 1 }] }), { status: 200 });
  if (p.includes('/service')) return new Response(JSON.stringify([{ id: 'svc-a', name: 'A' }, { id: 'svc-b', name: 'B' }]), { status: 200 });
  return new Response('', { status: 404 });
}) as typeof fetch;

function makeManager(opts: { secretBox?: SecretBox | null } = {}) {
  const auditEvents: Record<string, unknown>[] = [];
  const manager = new FastlyConnectorManager({
    baseConfig, repository: new FakeRepo(),
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); return undefined; } },
    isDevelopment: false, now: () => NOW, fetchImpl: cannedFetch,
  });
  return { manager, auditEvents };
}

async function app(role: string, manager?: FastlyConnectorManager, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { fastlyManager: manager, fastlyPoller: manager?.getPoller() });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('Fastly connection RBAC', () => {
  it('403 for a Viewing Engineer, 200 for an Engineer, 401 unauthenticated', async () => {
    const { manager } = makeManager();
    await manager.init();
    const ve = await app('VIEWING_ENGINEER', manager);
    expect((await ve.inject({ url: '/api/v1/cdn/fastly/connection' })).statusCode).toBe(403);
    await ve.close();
    const anon = await app('ENGINEER', manager, false);
    expect((await anon.inject({ url: '/api/v1/cdn/fastly/connection' })).statusCode).toBe(401);
    await anon.close();
    const eng = await app('ENGINEER', manager);
    expect((await eng.inject({ url: '/api/v1/cdn/fastly/connection' })).statusCode).toBe(200);
    manager.stop();
    await eng.close();
  });
});

describe('Fastly token write-only semantics + runtime reconfigure', () => {
  it('GET never returns the token; PUT replace/retain/clear reconfigure the poller', async () => {
    const { manager } = makeManager();
    await manager.init();
    const a = await app('ENGINEER', manager);

    let body = (await a.inject({ url: '/api/v1/cdn/fastly/connection' })).json();
    expect(body.settings.tokenConfigured).toBe(false);
    expect(body.settings).not.toHaveProperty('token');

    const put = await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { enabled: true, mode: 'live', apiBase: 'https://api.fastly.com', serviceIds: ['svc-a'], token: TOKEN } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.tokenConfigured).toBe(true);
    expect(put.json().settings.serviceIds).toEqual(['svc-a']);
    expect(put.body).not.toContain(TOKEN);
    // The change applied to the live poller: it is now enabled + live.
    expect(manager.getPoller().status().enabled).toBe(true);

    // Retain (no token field).
    await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { serviceIds: ['svc-a', 'svc-b'] } });
    body = (await a.inject({ url: '/api/v1/cdn/fastly/connection' })).json();
    expect(body.settings.tokenConfigured).toBe(true);
    expect(body.settings.serviceIds).toEqual(['svc-a', 'svc-b']);

    // Clear + disable → poller disabled.
    await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { enabled: false, clearToken: true } });
    expect((await a.inject({ url: '/api/v1/cdn/fastly/connection' })).json().settings.tokenConfigured).toBe(false);
    expect(manager.getPoller().status().enabled).toBe(false);

    manager.stop();
    await a.close();
  });

  it('rejects a masked placeholder; live requires a token', async () => {
    const { manager } = makeManager();
    await manager.init();
    const a = await app('ENGINEER', manager);
    expect((await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { token: '••••••••' } })).json().code).toBe('INVALID_TOKEN_VALUE');
    expect((await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { enabled: true, mode: 'live' } })).json().code).toBe('TOKEN_REQUIRED');
    manager.stop();
    await a.close();
  });
});

describe('Fastly fail closed + security proof', () => {
  it('409 when storing a token with no master key', async () => {
    const { manager } = makeManager({ secretBox: null });
    await manager.init();
    const a = await app('ENGINEER', manager);
    const res = await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { enabled: true, mode: 'live', token: TOKEN } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MASTER_KEY_UNAVAILABLE');
    await a.close();
  });

  it('the token appears in no response body or audit entry; test() uses it internally', async () => {
    const { manager, auditEvents } = makeManager();
    await manager.init();
    const a = await app('ENGINEER', manager);
    // No service ids configured → the test observes every service on the account (both).
    await a.inject({ method: 'PUT', url: '/api/v1/cdn/fastly/connection', payload: { enabled: true, mode: 'live', token: TOKEN } });
    const get = await a.inject({ url: '/api/v1/cdn/fastly/connection' });
    const test = await a.inject({ method: 'POST', url: '/api/v1/cdn/fastly/connection/test' });
    for (const raw of [get.body, test.body, JSON.stringify(auditEvents)]) expect(raw).not.toContain(TOKEN);
    expect(test.json().result.ok).toBe(true);
    expect(test.json().result.summary).toMatchObject({ services: 2 });
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', resourceKey: 'fastly', details: { tokenAction: 'replace' } });
    manager.stop();
    await a.close();
  });

  it('503 when no manager is wired', async () => {
    const a = await app('ENGINEER', undefined);
    expect((await a.inject({ url: '/api/v1/cdn/fastly/connection' })).statusCode).toBe(503);
    await a.close();
  });
});

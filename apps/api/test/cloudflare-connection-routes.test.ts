// Engineer-managed Cloudflare connection routes: RBAC (connector.manage), write-only token
// semantics (retain/replace/clear), masked-placeholder rejection, fail-closed without a master
// key, and the proof the token never appears in a response or audit entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CloudflareConnectorManager } from '../src/cloudflare/manager.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { CloudflareConfig } from '../src/cloudflare/config.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const TOKEN = 'cfat-ROUTE-SECRET-42';
const NOW = Date.parse('2026-07-16T12:00:00Z');

const baseConfig: CloudflareConfig = {
  enabled: false, mode: 'mock', apiBase: 'https://cf.test', lbZones: [], timeoutSeconds: 15,
  pollIntervalSeconds: 60, maxSampleAgeSeconds: 180, retryAttempts: 1,
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
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } }), { status: 200 });
  if (p.endsWith('/graphql')) return new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), { status: 200 });
  if (p.includes('/load_balancers/monitors')) return ok([]);
  if (p.includes('/load_balancers/pools')) return ok([{ id: 'p1', name: 'live-realta-citywest', enabled: true, healthy: true, monitor: 'm1', origins: [{ name: 'o1', address: '185.54.105.0', weight: 1, enabled: true, healthy: true }] }]);
  if (/\/zones\/[^/]+\/load_balancers/.test(p)) return ok([{ id: 'lb1', name: 'liveedge.rte.ie', zone_name: 'rte.ie', enabled: true, proxied: false, steering_policy: 'random', default_pools: ['p1'], fallback_pool: 'p1', region_pools: {}, pop_pools: {} }]);
  if (/\/zones\?/.test(p)) return ok([{ id: 'z1', name: 'rte.ie' }]);
  return new Response('', { status: 404 });
}) as typeof fetch;

function makeManager(opts: { secretBox?: SecretBox | null } = {}) {
  const auditEvents: Record<string, unknown>[] = [];
  const manager = new CloudflareConnectorManager({
    baseConfig, repository: new FakeRepo(),
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); return undefined; } },
    isDevelopment: false, now: () => NOW, fetchImpl: cannedFetch,
  });
  return { manager, auditEvents };
}

async function app(role: string, manager?: CloudflareConnectorManager, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { cloudflareManager: manager });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('Cloudflare connection RBAC', () => {
  it('403 for a Viewing Engineer, 200 for an Engineer, 401 unauthenticated', async () => {
    const { manager } = makeManager();
    const ve = await app('VIEWING_ENGINEER', manager);
    expect((await ve.inject({ url: '/api/v1/network/cloudflare/connection' })).statusCode).toBe(403);
    await ve.close();
    const anon = await app('ENGINEER', manager, false);
    expect((await anon.inject({ url: '/api/v1/network/cloudflare/connection' })).statusCode).toBe(401);
    await anon.close();
    const eng = await app('ENGINEER', manager);
    expect((await eng.inject({ url: '/api/v1/network/cloudflare/connection' })).statusCode).toBe(200);
    manager.stop();
    await eng.close();
  });
});

describe('Cloudflare token write-only semantics', () => {
  it('GET never returns the token; PUT replace/retain/clear behave correctly', async () => {
    const { manager } = makeManager();
    const a = await app('ENGINEER', manager);

    let body = (await a.inject({ url: '/api/v1/network/cloudflare/connection' })).json();
    expect(body.settings.tokenConfigured).toBe(false);
    expect(body.settings).not.toHaveProperty('token');

    const put = await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { enabled: true, mode: 'live', accountId: 'acct-1', zones: ['rte.ie'], token: TOKEN } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.tokenConfigured).toBe(true);
    expect(put.json().settings.accountId).toBe('acct-1');
    expect(put.json().settings.zones).toEqual(['rte.ie']);
    expect(put.body).not.toContain(TOKEN);

    // Retain (no token field).
    await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { zones: ['rte.ie', 'rte.host'] } });
    body = (await a.inject({ url: '/api/v1/network/cloudflare/connection' })).json();
    expect(body.settings.tokenConfigured).toBe(true);
    expect(body.settings.zones).toEqual(['rte.ie', 'rte.host']);

    // Clear.
    await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { enabled: false, clearToken: true } });
    expect((await a.inject({ url: '/api/v1/network/cloudflare/connection' })).json().settings.tokenConfigured).toBe(false);

    manager.stop();
    await a.close();
  });

  it('rejects a masked placeholder; live requires an account id + token', async () => {
    const { manager } = makeManager();
    const a = await app('ENGINEER', manager);
    expect((await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { token: '••••••••' } })).json().code).toBe('INVALID_TOKEN_VALUE');
    // Live with no account id.
    expect((await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { enabled: true, mode: 'live', token: TOKEN } })).json().code).toBe('ENDPOINT_REQUIRED');
    manager.stop();
    await a.close();
  });
});

describe('Cloudflare fail closed + security proof', () => {
  it('409 when storing a token with no master key', async () => {
    const { manager } = makeManager({ secretBox: null });
    const a = await app('ENGINEER', manager);
    const res = await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { enabled: true, mode: 'live', accountId: 'acct-1', token: TOKEN } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MASTER_KEY_UNAVAILABLE');
    await a.close();
  });

  it('the token appears in no response body or audit entry; test() uses it internally', async () => {
    const { manager, auditEvents } = makeManager();
    const a = await app('ENGINEER', manager);
    await a.inject({ method: 'PUT', url: '/api/v1/network/cloudflare/connection', payload: { enabled: true, mode: 'live', accountId: 'acct-1', zones: ['rte.ie'], token: TOKEN } });
    const get = await a.inject({ url: '/api/v1/network/cloudflare/connection' });
    const test = await a.inject({ method: 'POST', url: '/api/v1/network/cloudflare/connection/test' });
    for (const raw of [get.body, test.body, JSON.stringify(auditEvents)]) expect(raw).not.toContain(TOKEN);
    expect(test.json().result.ok).toBe(true);
    expect(test.json().result.summary).toMatchObject({ loadBalancers: 1, pools: 1 });
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', resourceKey: 'cloudflare', details: { tokenAction: 'replace' } });
    manager.stop();
    await a.close();
  });

  it('503 when no manager is wired', async () => {
    const a = await app('ENGINEER', undefined);
    expect((await a.inject({ url: '/api/v1/network/cloudflare/connection' })).statusCode).toBe(503);
    await a.close();
  });
});

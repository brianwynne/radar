// Engineer-managed NS1 connection routes: RBAC (connector.manage), write-only key semantics
// (retain/replace/clear), fail-closed without a master key, live requires HTTPS + a key, PUT swaps
// the live client, and the proof the key never appears in a response or audit entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Ns1ConnectorManager } from '../src/ns1/manager.js';
import { loadNs1Config } from '../src/ns1/index.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const KEY = 'ns1-READONLY-KEY-abc123';
const NOW = Date.parse('2026-07-17T12:00:00Z');

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

// Live client lists zones via GET {base}/zones with the key header — return two zones.
const cannedFetch = (async (input: RequestInfo | URL) => {
  if (String(input).includes('/zones')) return new Response(JSON.stringify([{ zone: 'rte.ie' }, { zone: 'rte.host' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('', { status: 404 });
}) as typeof fetch;

function makeManager(opts: { secretBox?: SecretBox | null } = {}) {
  const auditEvents: Record<string, unknown>[] = [];
  const manager = new Ns1ConnectorManager({
    baseConfig: loadNs1Config({}), repository: new FakeRepo(),
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); return undefined; } },
    fetchImpl: cannedFetch,
  });
  return { manager, auditEvents };
}

async function app(role: string, manager?: Ns1ConnectorManager, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { ns1Manager: manager, ns1Client: manager?.getClient() });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('NS1 connection RBAC', () => {
  it('403 Viewing Engineer, 401 unauthenticated, 200 Engineer, 503 with no manager', async () => {
    const { manager } = makeManager();
    await manager.init();
    const ve = await app('VIEWING_ENGINEER', manager);
    expect((await ve.inject({ url: '/api/v1/ns1/connection' })).statusCode).toBe(403);
    await ve.close();
    const anon = await app('ENGINEER', manager, false);
    expect((await anon.inject({ url: '/api/v1/ns1/connection' })).statusCode).toBe(401);
    await anon.close();
    const eng = await app('ENGINEER', manager);
    expect((await eng.inject({ url: '/api/v1/ns1/connection' })).statusCode).toBe(200);
    await eng.close();
    const none = await app('ENGINEER', undefined);
    expect((await none.inject({ url: '/api/v1/ns1/connection' })).statusCode).toBe(503);
    await none.close();
  });
});

describe('NS1 key write-only semantics + live test', () => {
  it('GET never returns the key; PUT goes live with a key; test lists zones read-only', async () => {
    const { manager, auditEvents } = makeManager();
    await manager.init();
    const a = await app('ENGINEER', manager);

    const body = (await a.inject({ url: '/api/v1/ns1/connection' })).json();
    expect(body.settings.keyConfigured).toBe(false);
    expect(body.settings.mode).toBe('mock');
    expect(body.settings).not.toHaveProperty('key'); // only keyConfigured metadata, never the value

    const put = await a.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { mode: 'live', apiBase: 'https://api.nsone.net/v1', key: KEY } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings).toMatchObject({ mode: 'live', live: true, keyConfigured: true });
    expect(put.body).not.toContain(KEY);

    const test = await a.inject({ method: 'POST', url: '/api/v1/ns1/connection/test' });
    expect(test.json().result).toMatchObject({ ok: true, summary: { zones: 2 } });

    // Retain (no key) then clear + back to mock.
    await a.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { apiBase: 'https://api.nsone.net/v1' } });
    expect((await a.inject({ url: '/api/v1/ns1/connection' })).json().settings.keyConfigured).toBe(true);
    await a.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { mode: 'mock', clearKey: true } });
    expect((await a.inject({ url: '/api/v1/ns1/connection' })).json().settings.keyConfigured).toBe(false);

    for (const raw of [put.body, test.body, JSON.stringify(auditEvents)]) expect(raw).not.toContain(KEY);
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', resourceKey: 'ns1', details: { tokenAction: 'replace' } });
    await a.close();
  });

  it('live requires a key + HTTPS; masked placeholder and no-master-key are rejected', async () => {
    const { manager } = makeManager();
    await manager.init();
    const a = await app('ENGINEER', manager);
    expect((await a.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { mode: 'live', apiBase: 'https://api.nsone.net/v1' } })).json().code).toBe('TOKEN_REQUIRED');
    expect((await a.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { mode: 'live', apiBase: 'http://api.nsone.net/v1', key: KEY } })).json().code).toBe('ENDPOINT_INSECURE');
    expect((await a.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { key: '••••••••' } })).json().code).toBe('INVALID_TOKEN_VALUE');
    await a.close();

    const noKey = makeManager({ secretBox: null });
    await noKey.manager.init();
    const a2 = await app('ENGINEER', noKey.manager);
    const res = await a2.inject({ method: 'PUT', url: '/api/v1/ns1/connection', payload: { mode: 'live', apiBase: 'https://api.nsone.net/v1', key: KEY } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MASTER_KEY_UNAVAILABLE');
    await a2.close();
  });
});

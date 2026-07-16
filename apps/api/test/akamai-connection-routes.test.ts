// Engineer-managed Akamai (DataStream 2 → S3) connection routes: RBAC (connector.manage), write-only
// S3-secret semantics (retain/replace/clear), fail-closed without a master key, PUT reconfigures the
// live connector, and the proof the secret never appears in a response or audit entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AkamaiConnectorManager } from '../src/akamai/manager.js';
import { loadAkamaiConfig } from '../src/akamai/index.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

const SECRET = 'S3-SECRET-KEY-abc123';
const NOW = Date.parse('2026-07-16T21:00:00Z');

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

const LIST_XML = '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>ds/x.json.gz</Key><LastModified>2026-07-16T21:00:00Z</LastModified><Size>10</Size></Contents></ListBucketResult>';
const cannedFetch = (async (input: RequestInfo | URL) => {
  if (String(input).includes('list-type=2')) return new Response(LIST_XML, { status: 200 });
  return new Response('', { status: 404 });
}) as typeof fetch;

function makeManager(opts: { secretBox?: SecretBox | null } = {}) {
  const auditEvents: Record<string, unknown>[] = [];
  const manager = new AkamaiConnectorManager({
    baseConfig: loadAkamaiConfig({}), repository: new FakeRepo(),
    secretBox: opts.secretBox === undefined ? new SecretBox(randomBytes(32)) : opts.secretBox,
    audit: { record: async (e) => { auditEvents.push(e as Record<string, unknown>); return undefined; } },
    now: () => NOW, fetchImpl: cannedFetch,
  });
  return { manager, auditEvents };
}

async function app(role: string, manager?: AkamaiConnectorManager, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { akamaiManager: manager, akamaiConnector: manager?.getConnector() });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('Akamai connection RBAC', () => {
  it('403 Viewing Engineer, 401 unauthenticated, 200 Engineer, 503 with no manager', async () => {
    const { manager } = makeManager();
    await manager.init();
    const ve = await app('VIEWING_ENGINEER', manager);
    expect((await ve.inject({ url: '/api/v1/cdn/akamai/connection' })).statusCode).toBe(403);
    await ve.close();
    const anon = await app('ENGINEER', manager, false);
    expect((await anon.inject({ url: '/api/v1/cdn/akamai/connection' })).statusCode).toBe(401);
    await anon.close();
    const eng = await app('ENGINEER', manager);
    expect((await eng.inject({ url: '/api/v1/cdn/akamai/connection' })).statusCode).toBe(200);
    manager.stop(); await eng.close();
    const none = await app('ENGINEER', undefined);
    expect((await none.inject({ url: '/api/v1/cdn/akamai/connection' })).statusCode).toBe(503);
    await none.close();
  });
});

describe('Akamai S3-secret write-only semantics + test', () => {
  it('GET never returns the secret; PUT stores S3 config; test() lists read-only', async () => {
    const { manager, auditEvents } = makeManager();
    await manager.init();
    const a = await app('ENGINEER', manager);

    let body = (await a.inject({ url: '/api/v1/cdn/akamai/connection' })).json();
    expect(body.settings.secretConfigured).toBe(false);
    expect(JSON.stringify(body.settings)).not.toContain('secretKey');

    const put = await a.inject({ method: 'PUT', url: '/api/v1/cdn/akamai/connection', payload: { enabled: true, cpCodes: ['1629049'], cpNames: { '1629049': 'LIVE.RTE.IE' }, bucket: 'rte-ds2', region: 'eu-west-1', prefix: 'ds/', accessKeyId: 'AKID', secretKey: SECRET } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.secretConfigured).toBe(true);
    expect(put.json().settings.s3).toMatchObject({ bucket: 'rte-ds2', region: 'eu-west-1', accessKeyId: 'AKID' });
    expect(put.json().settings.cpCodes).toEqual(['1629049']);
    expect(put.body).not.toContain(SECRET);

    const test = await a.inject({ method: 'POST', url: '/api/v1/cdn/akamai/connection/test' });
    expect(test.json().result.ok).toBe(true);

    // Retain: another PUT without a secret keeps it.
    await a.inject({ method: 'PUT', url: '/api/v1/cdn/akamai/connection', payload: { prefix: 'ds/logs/' } });
    body = (await a.inject({ url: '/api/v1/cdn/akamai/connection' })).json();
    expect(body.settings.secretConfigured).toBe(true);
    expect(body.settings.s3.prefix).toBe('ds/logs/');

    // Clear + disable.
    await a.inject({ method: 'PUT', url: '/api/v1/cdn/akamai/connection', payload: { enabled: false, clearSecret: true } });
    expect((await a.inject({ url: '/api/v1/cdn/akamai/connection' })).json().settings.secretConfigured).toBe(false);

    for (const raw of [put.body, test.body, JSON.stringify(auditEvents)]) expect(raw).not.toContain(SECRET);
    expect(auditEvents[0]).toMatchObject({ action: 'connector.settings.updated', resourceKey: 'akamai', details: { tokenAction: 'replace' } });
    manager.stop(); await a.close();
  });

  it('rejects a masked placeholder; 409 storing a secret with no master key', async () => {
    const masked = makeManager();
    await masked.manager.init();
    const a1 = await app('ENGINEER', masked.manager);
    expect((await a1.inject({ method: 'PUT', url: '/api/v1/cdn/akamai/connection', payload: { secretKey: '••••••••' } })).json().code).toBe('INVALID_TOKEN_VALUE');
    masked.manager.stop(); await a1.close();

    const noKey = makeManager({ secretBox: null });
    await noKey.manager.init();
    const a2 = await app('ENGINEER', noKey.manager);
    const res = await a2.inject({ method: 'PUT', url: '/api/v1/cdn/akamai/connection', payload: { enabled: true, secretKey: SECRET } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MASTER_KEY_UNAVAILABLE');
    await a2.close();
  });
});

import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database/repositories.js';
import type { AuditEvent, AuditRepository, ConfigurationSnapshot, SnapshotRepository } from '@radar/data';

/** In-memory database double (route-logic tests; real persistence is covered by the
 *  real-PostgreSQL integration test). */
function fakeDatabase() {
  const snaps: ConfigurationSnapshot[] = [];
  const audits: AuditEvent[] = [];
  let n = 0;
  const snapshots: SnapshotRepository = {
    async create(input) {
      const s: ConfigurationSnapshot = { ...input, id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, createdAt: new Date(), metadata: input.metadata ?? {} };
      snaps.push(s);
      return s;
    },
    async getById(id) {
      return snaps.find((s) => s.id === id) ?? null;
    },
    async list(q = {}) {
      return snaps.filter((s) => (!q.resourceKind || s.resourceKind === q.resourceKind) && (!q.resourceKey || s.resourceKey === q.resourceKey)).slice().reverse();
    },
  };
  const audit: AuditRepository = {
    async record(input) {
      const e: AuditEvent = { ...input, id: `a-${audits.length}`, occurredAt: new Date(), actorRoles: input.actorRoles ?? [], details: input.details ?? {} };
      audits.push(e);
      return e;
    },
    async list() {
      return audits.slice();
    },
  };
  const db: Database = { snapshots, audit, async transaction(fn) { return fn({ snapshots, audit }); } };
  return { db, snaps, audits };
}

async function makeApp(role: string | null, database?: Database): Promise<FastifyInstance> {
  const env: Record<string, string> = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  if (role) Object.assign(env, { RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: role });
  else env.RADAR_DEV_AUTH = 'false';
  const app = await buildApp(loadConfig(env), { database });
  await app.ready();
  return app;
}

const CAP = '/api/v1/ns1/zones/rte.ie/live.rte.ie/A/snapshots';

describe('snapshots — RBAC', () => {
  it('capture requires snapshot.create (401/403/201)', async () => {
    expect((await (await makeApp(null, fakeDatabase().db)).inject({ method: 'POST', url: CAP })).statusCode).toBe(401);
    expect((await (await makeApp('VIEWING_ENGINEER', fakeDatabase().db)).inject({ method: 'POST', url: CAP })).statusCode).toBe(403);
    expect((await (await makeApp('ENGINEER', fakeDatabase().db)).inject({ method: 'POST', url: CAP })).statusCode).toBe(201);
  });

  it('read routes require snapshot.read (NOC 403, Viewing Engineer 200)', async () => {
    const noc = await makeApp('NOC_VIEWER', fakeDatabase().db);
    expect((await noc.inject({ method: 'GET', url: CAP })).statusCode).toBe(403);
    const ve = await makeApp('VIEWING_ENGINEER', fakeDatabase().db);
    expect((await ve.inject({ method: 'GET', url: CAP })).statusCode).toBe(200);
  });

  it('returns 503 when persistence is not configured', async () => {
    const app = await makeApp('ENGINEER'); // no database
    expect((await app.inject({ method: 'POST', url: CAP })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: CAP })).statusCode).toBe(503);
  });
});

describe('snapshots — capture, history, detail', () => {
  it('captures with preserved raw, canonical, checksums, metadata and an atomic audit event', async () => {
    const { db, snaps, audits } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const res = await app.inject({ method: 'POST', url: CAP, payload: { label: 'before change' } });
    expect(res.statusCode).toBe(201);
    const snap = res.json().snapshot;
    expect(snap.resourceKey).toBe('rte.ie/live.rte.ie/A');
    expect(snap.createdBySubject).toBeDefined();
    expect(snap.label).toBe('before change');
    expect(snap.rawChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snap.structuralChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((snap.rawPayload as { domain: string }).domain).toBe('live.rte.ie'); // raw preserved
    expect(snap.canonicalPayload).toBeDefined();
    expect(snap.metadata).toMatchObject({ mode: 'mock', synthetic: true });
    expect(snap.metadata.warnings.length).toBeGreaterThan(0);
    // Audit written atomically with the snapshot.
    expect(snaps).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'snapshot.create', resourceType: 'record', outcome: 'success' });
    expect((audits[0].details as { snapshotId: string }).snapshotId).toBe(snap.id);
  });

  it('lists history (summaries, no payloads) and fetches detail (with payloads)', async () => {
    const { db } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const created = (await app.inject({ method: 'POST', url: CAP })).json().snapshot;

    const history = await app.inject({ method: 'GET', url: CAP });
    expect(history.json().count).toBe(1);
    expect(history.json().snapshots[0].rawPayload).toBeUndefined(); // summary omits payloads

    const detail = await app.inject({ method: 'GET', url: `/api/v1/snapshots/${created.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().snapshot.rawPayload).toBeDefined();

    expect((await app.inject({ method: 'GET', url: '/api/v1/snapshots/not-a-uuid' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/snapshots/00000000-0000-0000-0000-0000000000ff' })).statusCode).toBe(404);
  });
});

describe('snapshots — compare', () => {
  it('reports identical for the same record and a diff for different records', async () => {
    const { db } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const a = (await app.inject({ method: 'POST', url: CAP })).json().snapshot;
    const b = (await app.inject({ method: 'POST', url: CAP })).json().snapshot; // same record → identical
    const c = (await app.inject({ method: 'POST', url: '/api/v1/ns1/zones/rte.ie/vod.rte.ie/A/snapshots' })).json().snapshot;

    const same = await app.inject({ method: 'POST', url: '/api/v1/snapshots/compare', payload: { a: a.id, b: b.id } });
    expect(same.statusCode).toBe(200);
    expect(same.json().identical).toBe(true);
    expect(same.json().diffCount).toBe(0);

    const diff = await app.inject({ method: 'POST', url: '/api/v1/snapshots/compare', payload: { a: a.id, b: c.id } });
    expect(diff.json().identical).toBe(false);
    expect(diff.json().diffCount).toBeGreaterThan(0);
    expect(Array.isArray(diff.json().diff)).toBe(true);

    // Validation and missing ids.
    expect((await app.inject({ method: 'POST', url: '/api/v1/snapshots/compare', payload: { a: 'x' } })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/snapshots/compare', payload: { a: a.id, b: '00000000-0000-0000-0000-0000000000ff' } });
    expect(missing.statusCode).toBe(404);
  });
});

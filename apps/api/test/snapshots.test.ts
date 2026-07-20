import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database/repositories.js';
import { diffJson, summariseRecordDiff } from '../src/ns1/snapshot.js';
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
    async updateLabel(id, label) {
      const s = snaps.find((x) => x.id === id);
      if (!s) return null;
      s.label = label && label.trim() ? label.trim() : undefined;
      return s;
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

describe('snapshots — rename', () => {
  it('renames a snapshot (label only) and audits it, and clears on blank', async () => {
    const { db, snaps, audits } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const id = (await app.inject({ method: 'POST', url: CAP })).json().snapshot.id;

    const res = await app.inject({ method: 'PATCH', url: `/api/v1/snapshots/${id}`, payload: { label: '  before failover  ' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshot.label).toBe('before failover'); // trimmed
    expect(snaps[0].label).toBe('before failover');
    expect(audits.some((a) => a.action === 'snapshot.relabel' && (a.details as { snapshotId: string }).snapshotId === id)).toBe(true);
    // The captured payload/checksum is untouched by a rename.
    expect(res.json().snapshot.rawChecksum).toMatch(/^sha256:/);

    const cleared = await app.inject({ method: 'PATCH', url: `/api/v1/snapshots/${id}`, payload: { label: '' } });
    expect(cleared.json().snapshot.label ?? null).toBeNull();
  });

  it('rename requires snapshot.create; unknown id 404s', async () => {
    const ve = await makeApp('VIEWING_ENGINEER', fakeDatabase().db);
    expect((await ve.inject({ method: 'PATCH', url: '/api/v1/snapshots/00000000-0000-0000-0000-000000000001', payload: { label: 'x' } })).statusCode).toBe(403);
    const eng = await makeApp('ENGINEER', fakeDatabase().db);
    expect((await eng.inject({ method: 'PATCH', url: '/api/v1/snapshots/00000000-0000-0000-0000-0000000000ee', payload: { label: 'x' } })).statusCode).toBe(404);
  });
});

describe('snapshots — provenance follows the effective connector mode', () => {
  it('labels a snapshot live when the connector manager is effectively live (not the startup mode)', async () => {
    const { db } = fakeDatabase();
    // Startup config is mock, but the connector manager reports effectively-live — the snapshot
    // must be labelled by how it was actually fetched, not the startup RADAR_MODE.
    const ns1Manager = { effectiveConnection: () => ({ mode: 'live' as const, baseUrl: 'https://api.nsone.net/v1' }) };
    const app = await buildApp(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'ENGINEER' }),
      { database: db, ns1Manager } as unknown as Parameters<typeof buildApp>[1],
    );
    await app.ready();
    const res = await app.inject({ method: 'POST', url: CAP });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.provenance).toMatchObject({ mode: 'live', synthetic: false });
    expect(body.snapshot.metadata).toMatchObject({ mode: 'live', synthetic: false });
    expect(body.snapshot.metadata.warnings).toHaveLength(0); // no "captured in mock mode" warning
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

describe('summariseRecordDiff (record-aware classification)', () => {
  const base = {
    ttl: 30,
    use_client_subnet: true,
    answers: [{ id: 'a', answer: ['1'] }, { id: 'b', answer: ['2'] }],
    filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }],
  };
  const sum = (before: unknown, after: unknown) => summariseRecordDiff(before, after, diffJson(before, after));

  it('identical → all zero/false', () => {
    expect(sum(base, base)).toEqual({ ttlChanged: false, ecsChanged: false, answersAdded: 0, answersRemoved: 0, answersChanged: 0, filtersAdded: 0, filtersRemoved: 0, filtersChanged: 0, filtersReordered: false, otherChanges: 0 });
  });
  it('detects a TTL change', () => expect(sum(base, { ...base, ttl: 60 }).ttlChanged).toBe(true));
  it('detects an ECS-setting change', () => expect(sum(base, { ...base, use_client_subnet: false }).ecsChanged).toBe(true));
  it('detects an added answer', () => expect(sum(base, { ...base, answers: [...base.answers, { id: 'c', answer: ['3'] }] }).answersAdded).toBe(1));
  it('detects a removed answer', () => expect(sum(base, { ...base, answers: [base.answers[0]] }).answersRemoved).toBe(1));
  it('detects a changed answer (metadata)', () => expect(sum(base, { ...base, answers: [{ id: 'a', answer: ['1'], meta: { weight: 5 } }, base.answers[1]] }).answersChanged).toBe(1));
  it('detects an added filter', () => expect(sum(base, { ...base, filters: [...base.filters, { filter: 'select_first_n' }] }).filtersAdded).toBe(1));
  it('detects a removed filter', () => expect(sum(base, { ...base, filters: [base.filters[0]] }).filtersRemoved).toBe(1));
  it('detects a reordered filter chain', () => {
    const s = sum(base, { ...base, filters: [base.filters[1], base.filters[0]] });
    expect(s.filtersReordered).toBe(true);
    expect(s.filtersAdded).toBe(0);
    expect(s.filtersRemoved).toBe(0);
  });
  it('detects a filter config change', () => expect(sum(base, { ...base, filters: [{ filter: 'up' }, { filter: 'weighted_shuffle', config: { x: 1 } }] }).filtersChanged).toBe(1));
  it('classifies an unknown-field change as a structural (other) change', () => expect(sum(base, { ...base, regions: { eu: {} } }).otherChanges).toBeGreaterThan(0));
});

describe('snapshots — compare-current', () => {
  const seed = (db: Database, canonicalPayload: unknown, structuralChecksum: string) =>
    db.snapshots.create({ sourceSystem: 'ns1', resourceKind: 'record', resourceKey: 'rte.ie/live.rte.ie/A', retrievedAt: new Date(), rawPayload: {}, canonicalPayload, rawChecksum: 'sha256:seed', structuralChecksum, metadata: { mode: 'mock', synthetic: true } });

  it('403 without snapshot.read, 401 unauthenticated, 404 for unknown', async () => {
    const dummy = '00000000-0000-0000-0000-0000000000ff';
    expect((await (await makeApp('NOC_VIEWER', fakeDatabase().db)).inject({ method: 'POST', url: `/api/v1/snapshots/${dummy}/compare-current` })).statusCode).toBe(403);
    expect((await (await makeApp(null, fakeDatabase().db)).inject({ method: 'POST', url: `/api/v1/snapshots/${dummy}/compare-current` })).statusCode).toBe(401);
    expect((await (await makeApp('VIEWING_ENGINEER', fakeDatabase().db)).inject({ method: 'POST', url: `/api/v1/snapshots/${dummy}/compare-current` })).statusCode).toBe(404);
  });

  it('fetches the current record server-side; identical when unchanged; ignores any submitted payload; creates no new snapshot', async () => {
    const { db, snaps } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const id = (await app.inject({ method: 'POST', url: CAP })).json().snapshot.id; // capture the current record
    const res = await app.inject({ method: 'POST', url: `/api/v1/snapshots/${id}/compare-current`, payload: { current: { spoofed: true } } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identical).toBe(true);
    expect(body.rawChecksumEqual).toBe(true); // server-fetched, not from the submitted body
    expect(body.current.sourceMode).toBe('mock');
    expect(body.current.synthetic).toBe(true);
    expect(body.summary).toMatchObject({ answersAdded: 0, answersRemoved: 0, filtersReordered: false });
    expect(snaps).toHaveLength(1); // no new snapshot created by comparison
  });

  it('detects changes and identical=false when the snapshot differs from the current record', async () => {
    const { db } = fakeDatabase();
    const app = await makeApp('VIEWING_ENGINEER', db);
    const snap = await seed(db, { ttl: 999, use_client_subnet: false, answers: [], filters: [] }, 'sha256:different');
    const res = await app.inject({ method: 'POST', url: `/api/v1/snapshots/${snap.id}/compare-current` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identical).toBe(false);
    expect(body.summary.ttlChanged).toBe(true);
    expect(body.summary.ecsChanged).toBe(true);
    expect(body.summary.answersAdded).toBeGreaterThan(0); // current has answers; the seed had none
    expect(body.summary.filtersAdded).toBeGreaterThan(0);
    expect(body.snapshot.id).toBe(snap.id);
  });

  it('compares a snapshot against a DIFFERENT current record when a target is given', async () => {
    const { db } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const id = (await app.inject({ method: 'POST', url: CAP })).json().snapshot.id; // snapshot of live.rte.ie/A
    // Diff it against the current vod.rte.ie/A record (a different record in the zone).
    const res = await app.inject({ method: 'POST', url: `/api/v1/snapshots/${id}/compare-current`, payload: { zone: 'rte.ie', domain: 'vod.rte.ie', type: 'A' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.crossRecord).toBe(true);
    expect(body.target).toEqual({ zone: 'rte.ie', domain: 'vod.rte.ie', type: 'A' });
    expect(body.current.resourceKey).toBe('rte.ie/vod.rte.ie/A');
    expect(body.identical).toBe(false); // different records differ
    expect(body.warnings.some((w: string) => /across different records/i.test(w))).toBe(true);
  });

  it('rejects a partial target (zone, domain and type must be given together)', async () => {
    const { db } = fakeDatabase();
    const app = await makeApp('ENGINEER', db);
    const id = (await app.inject({ method: 'POST', url: CAP })).json().snapshot.id;
    expect((await app.inject({ method: 'POST', url: `/api/v1/snapshots/${id}/compare-current`, payload: { zone: 'rte.ie' } })).statusCode).toBe(400);
  });
});

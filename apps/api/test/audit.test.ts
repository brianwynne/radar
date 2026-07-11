import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database/repositories.js';
import type { AuditEvent, AuditQuery, AuditRepository, SnapshotRepository } from '@radar/data';

function fakeDb() {
  const events: AuditEvent[] = [];
  const queries: AuditQuery[] = [];
  const audit: AuditRepository = {
    async record(input) {
      const e: AuditEvent = { ...input, id: `e-${events.length}`, occurredAt: new Date(), actorRoles: input.actorRoles ?? [], details: input.details ?? {} };
      events.push(e);
      return e;
    },
    async list(q = {}) {
      queries.push(q);
      return events.slice().reverse(); // newest first
    },
  };
  const snapshots: SnapshotRepository = { async create() { throw new Error('n/a'); }, async getById() { return null; }, async list() { return []; } };
  const db: Database = { snapshots, audit, async transaction(fn) { return fn({ snapshots, audit }); } };
  return { db, events, queries };
}

async function makeApp(role: string | null, database?: Database): Promise<FastifyInstance> {
  const env: Record<string, string> = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  if (role) Object.assign(env, { RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: role });
  else env.RADAR_DEV_AUTH = 'false';
  const app = await buildApp(loadConfig(env), { database });
  await app.ready();
  return app;
}

const URL = '/api/v1/audit';

describe('GET /api/v1/audit — RBAC & availability', () => {
  it('401 unauthenticated, 403 for NOC (no audit.read), 200 for Viewing Engineer', async () => {
    expect((await (await makeApp(null, fakeDb().db)).inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    expect((await (await makeApp('NOC_VIEWER', fakeDb().db)).inject({ method: 'GET', url: URL })).statusCode).toBe(403);
    expect((await (await makeApp('VIEWING_ENGINEER', fakeDb().db)).inject({ method: 'GET', url: URL })).statusCode).toBe(200);
  });
  it('503 when persistence is unconfigured', async () => {
    expect((await (await makeApp('VIEWING_ENGINEER')).inject({ method: 'GET', url: URL })).statusCode).toBe(503);
  });
});

describe('GET /api/v1/audit — data & filtering', () => {
  it('returns RADAR audit events newest-first with provenance', async () => {
    const { db, events } = fakeDb();
    await db.audit.record({ action: 'snapshot.create', outcome: 'success', actorSubject: 'a', authenticationMethod: 'dev', correlationId: 'corr-1', resourceType: 'record', resourceKey: 'rte.ie/live.rte.ie/A' });
    await db.audit.record({ action: 'auth.login', outcome: 'success', actorSubject: 'b', authenticationMethod: 'oidc', correlationId: 'corr-2' });
    const app = await makeApp('VIEWING_ENGINEER', db);
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provenance).toMatchObject({ source: 'radar', readOnly: true });
    expect(body.count).toBe(2);
    expect(body.items[0].action).toBe('auth.login'); // newest first
    expect(body.items[0]).toHaveProperty('authenticationMethod');
    expect(body.items[0]).toHaveProperty('correlationId');
    expect(events).toHaveLength(2);
    await app.close();
  });

  it('maps and forwards bounded filters to the repository (parameterised)', async () => {
    const { db, queries } = fakeDb();
    const app = await makeApp('VIEWING_ENGINEER', db);
    await app.inject({
      method: 'GET',
      url: `${URL}?actor=alice&action=snapshot.create&resourceType=record&resourceKey=k&outcome=success&correlationId=c-1&after=2026-07-01T00:00:00Z&before=2026-07-02T00:00:00Z&limit=50`,
    });
    const q = queries[0];
    expect(q.actorSubject).toBe('alice');
    expect(q.action).toBe('snapshot.create');
    expect(q.resourceType).toBe('record');
    expect(q.resourceKey).toBe('k');
    expect(q.outcome).toBe('success');
    expect(q.correlationId).toBe('c-1');
    expect(q.limit).toBe(50);
    expect(q.occurredAfter).toBeInstanceOf(Date);
    expect(q.occurredBefore).toBeInstanceOf(Date);
    await app.close();
  });

  it('rejects an invalid query (bad date or limit) with 400', async () => {
    const app = await makeApp('VIEWING_ENGINEER', fakeDb().db);
    for (const qs of ['before=not-a-date', 'limit=abc', 'limit=0']) {
      const res = await app.inject({ method: 'GET', url: `${URL}?${qs}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_REQUEST');
    }
    await app.close();
  });

  it('never leaks credential-like fields from audit details', async () => {
    const { db } = fakeDb();
    await db.audit.record({ action: 'x', outcome: 'success', details: { snapshotId: 's1', api_key: 'SECRET-VALUE', authorization: 'Bearer t', token: 't', note: 'safe' } });
    const app = await makeApp('VIEWING_ENGINEER', db);
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.payload).not.toMatch(/SECRET-VALUE|Bearer t/);
    const details = res.json().items[0].details;
    expect(details.snapshotId).toBe('s1');
    expect(details.note).toBe('safe');
    expect(details.api_key).toBeUndefined();
    expect(details.authorization).toBeUndefined();
    expect(details.token).toBeUndefined();
    await app.close();
  });
});

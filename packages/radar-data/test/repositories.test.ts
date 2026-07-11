import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import {
  applyMigrations,
  loadMigrations,
  splitStatements,
  PostgresSnapshotRepository,
  PostgresAuditRepository,
  type Queryable,
} from '../src/index.js';

/** A fresh in-memory PostgreSQL with the real migrations applied. This exercises the
 *  actual 0001_init.sql, so schema drift between migration and code is caught here
 *  without needing Docker. */
async function freshDb(): Promise<{ mem: IMemoryDb; db: Queryable }> {
  // noAstCoverageCheck relaxes a pg-mem-only strictness: re-running `CREATE TABLE IF NOT
  // EXISTS` against an already-existing table (the migration idempotency path) otherwise
  // trips its "unread AST" guard. Real PostgreSQL treats it as a no-op.
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Queryable;
  await applyMigrations(db, loadMigrations());
  return { mem, db };
}

const sampleSnapshot = {
  sourceSystem: 'ns1',
  resourceKind: 'record',
  resourceKey: 'live.rte.ie/A',
  sourceEndpoint: 'https://api.nsone.net/v1/zones/rte.ie/live.rte.ie/A',
  retrievedAt: new Date('2026-07-01T10:00:00.000Z'),
  createdBySubject: 'user-oid-1',
  label: 'demo capture',
  rawPayload: { answers: [{ answer: ['realta'] }], filters: [{ filter: 'up' }] },
  canonicalPayload: { answers: ['realta'] },
  rawChecksum: 'sha256:abc',
  structuralChecksum: 'sha256:struct',
  metadata: { note: 'nested', tags: ['a', 'b'] },
};

describe('migrations', () => {
  it('splitStatements respects semicolons inside string literals', () => {
    const stmts = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'a;b'");
  });

  it('applies the initial schema and is idempotent', async () => {
    const { db } = await freshDb();
    const second = await applyMigrations(db, loadMigrations());
    expect(second).toEqual([]); // nothing left to apply
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });
});

describe('PostgresSnapshotRepository', () => {
  let db: Queryable;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });

  it('creates a snapshot, generating an id and created_at, preserving payloads', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create(sampleSnapshot);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.retrievedAt.toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(created.rawPayload).toEqual(sampleSnapshot.rawPayload);
    expect(created.canonicalPayload).toEqual(sampleSnapshot.canonicalPayload);
    expect(created.metadata).toEqual(sampleSnapshot.metadata);
  });

  it('round-trips via getById and returns null for an unknown id', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create(sampleSnapshot);
    const fetched = await repo.getById(created.id);
    expect(fetched?.resourceKey).toBe('live.rte.ie/A');
    expect(fetched?.rawPayload).toEqual(sampleSnapshot.rawPayload);
    expect(await repo.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('applies defaults for optional fields', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create({
      sourceSystem: 'ns1',
      resourceKind: 'zone',
      resourceKey: 'rte.ie',
      retrievedAt: new Date('2026-07-02T00:00:00.000Z'),
      rawPayload: { a: 1 },
      canonicalPayload: { a: 1 },
      rawChecksum: 'sha256:z',
    });
    expect(created.sourceEndpoint).toBeUndefined();
    expect(created.label).toBeUndefined();
    expect(created.structuralChecksum).toBeUndefined();
    expect(created.metadata).toEqual({});
  });

  it('lists filtered by resource identity and source, newest first, bounded', async () => {
    const repo = new PostgresSnapshotRepository(db);
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-01T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-03T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, resourceKey: 'other/A' });

    const forRecord = await repo.list({ resourceKind: 'record', resourceKey: 'live.rte.ie/A' });
    expect(forRecord).toHaveLength(2);
    expect(forRecord[0].retrievedAt.toISOString()).toBe('2026-07-03T00:00:00.000Z'); // newest first

    expect(await repo.list({ sourceSystem: 'ns1' })).toHaveLength(3);
    expect(await repo.list({ resourceKey: 'other/A' })).toHaveLength(1);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });
});

describe('PostgresAuditRepository', () => {
  let db: Queryable;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });

  it('records an event with roles and details, defaulting occurred_at', async () => {
    const repo = new PostgresAuditRepository(db);
    const event = await repo.record({
      actorSubject: 'user-oid-1',
      actorRoles: ['ENGINEER', 'NOC_VIEWER'],
      authenticationMethod: 'oidc',
      action: 'snapshot.create',
      resourceType: 'record',
      resourceKey: 'live.rte.ie/A',
      outcome: 'success',
      correlationId: 'corr-123',
      details: { fields: 3 },
    });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.actorRoles).toEqual(['ENGINEER', 'NOC_VIEWER']);
    expect(event.details).toEqual({ fields: 3 });
  });

  it('defaults roles/details and filters list queries', async () => {
    const repo = new PostgresAuditRepository(db);
    await repo.record({ action: 'auth.login', outcome: 'success', actorSubject: 'a' });
    await repo.record({ action: 'auth.login', outcome: 'failure', actorSubject: 'b', correlationId: 'c-9' });
    await repo.record({ action: 'snapshot.create', outcome: 'success', actorSubject: 'a' });

    const [firstLogin] = await repo.list({ action: 'auth.login', actorSubject: 'a' });
    expect(firstLogin.actorRoles).toEqual([]);
    expect(firstLogin.details).toEqual({});

    expect(await repo.list({ action: 'auth.login' })).toHaveLength(2);
    expect(await repo.list({ actorSubject: 'a' })).toHaveLength(2);
    expect(await repo.list({ correlationId: 'c-9' })).toHaveLength(1);
  });
});

// FAST SUPPLEMENTARY coverage using pg-mem (in-memory PostgreSQL). This is NOT
// authoritative PostgreSQL validation — pg-mem emulates and differs in places (no real
// transaction rollback, stricter AST-coverage guard). The authoritative proof lives in
// test/integration/postgres.integration.test.ts against a real server.
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import {
  applyMigrations,
  loadMigrations,
  migrationStatus,
  migrationChecksum,
  MigrationChecksumError,
  PostgresSnapshotRepository,
  PostgresAuditRepository,
  type Queryable,
} from '../src/index.js';

async function freshDb(): Promise<{ mem: IMemoryDb; db: Queryable }> {
  // noAstCoverageCheck relaxes a pg-mem-only strictness (re-running CREATE TABLE IF NOT
  // EXISTS trips its "unread AST" guard). Real PostgreSQL treats it as a no-op.
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

describe('migrations (pg-mem)', () => {
  it('applies the initial schema, is idempotent, and reports status', async () => {
    const { db } = await freshDb();
    expect(await applyMigrations(db, loadMigrations())).toEqual([]); // nothing left
    const status = await migrationStatus(db, loadMigrations());
    expect(status).toEqual([{ version: '0001_init', filename: '0001_init.sql', applied: true, checksumMatches: true }]);
  });

  it('rejects an already-applied migration whose checksum changed', async () => {
    const { db } = await freshDb();
    const tampered = loadMigrations().map((m) => ({ ...m, sql: `${m.sql}\n-- altered`, checksum: migrationChecksum(`${m.sql}\n-- altered`) }));
    await expect(applyMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });
});

describe('PostgresSnapshotRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });

  it('creates, round-trips via getById, and returns null for unknown ids', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create(sampleSnapshot);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBeInstanceOf(Date);
    const fetched = await repo.getById(created.id);
    expect(fetched?.rawPayload).toEqual(sampleSnapshot.rawPayload);
    expect(fetched?.metadata).toEqual(sampleSnapshot.metadata);
    expect(await repo.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists filtered by identity/source, newest first, bounded', async () => {
    const repo = new PostgresSnapshotRepository(db);
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-01T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-03T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, resourceKey: 'other/A' });
    const forRecord = await repo.list({ resourceKind: 'record', resourceKey: 'live.rte.ie/A' });
    expect(forRecord).toHaveLength(2);
    expect(forRecord[0].retrievedAt.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(await repo.list({ sourceSystem: 'ns1' })).toHaveLength(3);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });
});

describe('PostgresAuditRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });

  it('records roles (text[]) and details (jsonb), defaulting empties, and filters lists', async () => {
    const repo = new PostgresAuditRepository(db);
    const ev = await repo.record({
      actorSubject: 'user-oid-1',
      actorRoles: ['ENGINEER', 'NOC_VIEWER'],
      action: 'snapshot.create',
      outcome: 'success',
      correlationId: 'corr-123',
      details: { fields: 3 },
    });
    expect(ev.actorRoles).toEqual(['ENGINEER', 'NOC_VIEWER']);
    expect(ev.details).toEqual({ fields: 3 });

    await repo.record({ action: 'auth.login', outcome: 'failure', actorSubject: 'b' });
    const [login] = await repo.list({ action: 'auth.login' });
    expect(login.actorRoles).toEqual([]);
    expect(login.details).toEqual({});
    expect(await repo.list({ correlationId: 'corr-123' })).toHaveLength(1);
  });
});

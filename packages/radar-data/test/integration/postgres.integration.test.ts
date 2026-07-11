// Authoritative persistence tests against a REAL PostgreSQL server. These are the
// authoritative proof for the persistence layer; the pg-mem suite is fast supplementary
// coverage only. Skipped unless PG_INTEGRATION_URL points at a disposable database
// (CI provides a PostgreSQL service container; locally an embedded server can be used).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import {
  applyMigrations,
  loadMigrations,
  PostgresAuditRepository,
  PostgresSnapshotRepository,
  type Queryable,
} from '../../src/index.js';

const PG_URL = process.env.PG_INTEGRATION_URL;

const sampleSnapshot = {
  sourceSystem: 'ns1',
  resourceKind: 'record',
  resourceKey: 'live.rte.ie/A',
  sourceEndpoint: 'https://api.nsone.net/v1/zones/rte.ie/live.rte.ie/A',
  retrievedAt: new Date('2026-07-01T10:00:00.000Z'),
  createdBySubject: 'user-oid-1',
  label: 'demo capture',
  rawPayload: { answers: [{ answer: ['réalta'], meta: { up: true, weight: 70, asn: [5466, 15502] } }] },
  canonicalPayload: { answers: ['réalta'] },
  rawChecksum: 'sha256:abc',
  structuralChecksum: 'sha256:struct',
  metadata: { note: 'nested ✓', tags: ['a', 'b'] },
};

describe.skipIf(!PG_URL)('PostgreSQL integration (real database)', () => {
  let pool: pg.Pool;
  const q = (): Queryable => pool as unknown as Queryable;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    // Clean slate so the run is deterministic regardless of prior state.
    await pool.query('DROP TABLE IF EXISTS configuration_snapshots, audit_events, schema_migrations CASCADE');
    const applied = await applyMigrations(q(), loadMigrations());
    expect(applied).toContain('0001_init.sql');
  });

  afterEach(async () => {
    await pool.query('TRUNCATE configuration_snapshots, audit_events');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies the checked-in migrations and is idempotent on real PostgreSQL', async () => {
    const again = await applyMigrations(q(), loadMigrations());
    expect(again).toEqual([]); // nothing left to apply on a second run
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('creates the expected column types and every declared index', async () => {
    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'configuration_snapshots'`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName.id.data_type).toBe('uuid');
    expect(byName.raw_payload.data_type).toBe('jsonb');
    expect(byName.canonical_payload.data_type).toBe('jsonb');
    expect(byName.retrieved_at.data_type).toBe('timestamp with time zone');
    expect(byName.source_system.is_nullable).toBe('NO');

    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('configuration_snapshots', 'audit_events')`,
    );
    const names = idx.rows.map((r) => r.indexname);
    for (const expected of [
      'idx_snapshots_resource',
      'idx_snapshots_source',
      'idx_snapshots_checksum',
      'idx_snapshots_created',
      'idx_audit_occurred',
      'idx_audit_actor',
      'idx_audit_action',
      'idx_audit_resource',
      'idx_audit_correlation',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('enforces NOT NULL constraints from the schema', async () => {
    // source_system is NOT NULL — omitting it must be rejected by the database.
    await expect(
      pool.query(
        `INSERT INTO configuration_snapshots
           (id, resource_kind, resource_key, retrieved_at, raw_payload, canonical_payload, raw_checksum)
         VALUES (gen_random_uuid(), 'record', 'k', now(), '{}'::jsonb, '{}'::jsonb, 'c')`,
      ),
    ).rejects.toThrow();
  });

  it('round-trips a snapshot, preserving nested JSONB and unicode exactly', async () => {
    const repo = new PostgresSnapshotRepository(q());
    const created = await repo.create(sampleSnapshot);
    const fetched = await repo.getById(created.id);
    expect(fetched?.rawPayload).toEqual(sampleSnapshot.rawPayload);
    expect(fetched?.canonicalPayload).toEqual(sampleSnapshot.canonicalPayload);
    expect(fetched?.metadata).toEqual(sampleSnapshot.metadata);
    expect(fetched?.retrievedAt.toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(fetched?.createdAt).toBeInstanceOf(Date);
    expect(await repo.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists snapshots filtered by identity/source, newest first, bounded', async () => {
    const repo = new PostgresSnapshotRepository(q());
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-01T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-03T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, resourceKey: 'other/A' });

    const forRecord = await repo.list({ resourceKind: 'record', resourceKey: 'live.rte.ie/A' });
    expect(forRecord).toHaveLength(2);
    expect(forRecord[0].retrievedAt.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(await repo.list({ sourceSystem: 'ns1' })).toHaveLength(3);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });

  it('records and queries audit events with JSONB roles/details', async () => {
    const repo = new PostgresAuditRepository(q());
    const ev = await repo.record({
      actorSubject: 'user-oid-1',
      actorRoles: ['ENGINEER', 'NOC_VIEWER'],
      authenticationMethod: 'oidc',
      action: 'snapshot.create',
      resourceType: 'record',
      resourceKey: 'live.rte.ie/A',
      outcome: 'success',
      correlationId: 'corr-123',
      details: { fields: 3, nested: { ok: true } },
    });
    expect(ev.occurredAt).toBeInstanceOf(Date);
    const [fetched] = await repo.list({ correlationId: 'corr-123' });
    expect(fetched.actorRoles).toEqual(['ENGINEER', 'NOC_VIEWER']);
    expect(fetched.details).toEqual({ fields: 3, nested: { ok: true } });
    await repo.record({ action: 'auth.login', outcome: 'failure' });
    expect((await repo.list({}))[0].actorRoles).toEqual([]); // default applied by DB
    expect(await repo.list({ action: 'snapshot.create' })).toHaveLength(1);
  });

  it('honours transaction rollback and commit for multi-step writes', async () => {
    const poolRepo = new PostgresSnapshotRepository(q());
    const client = await pool.connect();
    try {
      const txRepo = new PostgresSnapshotRepository(client as unknown as Queryable);

      await client.query('BEGIN');
      const rolledBack = await txRepo.create(sampleSnapshot);
      await client.query('ROLLBACK');
      expect(await poolRepo.getById(rolledBack.id)).toBeNull();

      await client.query('BEGIN');
      const committed = await txRepo.create(sampleSnapshot);
      await client.query('COMMIT');
      expect(await poolRepo.getById(committed.id)).not.toBeNull();
    } finally {
      client.release();
    }
  });

  it('advisory locks are mutually exclusive across connections (migration guard)', async () => {
    const key = 5203071; // same key the migrate runner uses
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('SELECT pg_advisory_lock($1)', [key]);
      const contended = await b.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [key]);
      expect(contended.rows[0].got).toBe(false); // b cannot acquire while a holds it
      await a.query('SELECT pg_advisory_unlock($1)', [key]);
      const afterRelease = await b.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [key]);
      expect(afterRelease.rows[0].got).toBe(true);
      await b.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      a.release();
      b.release();
    }
  });
});

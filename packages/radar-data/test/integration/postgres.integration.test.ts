// AUTHORITATIVE persistence tests against a REAL PostgreSQL server. The pg-mem suite is
// fast supplementary coverage only. Runs against TEST_DATABASE_URL, which MUST point at a
// disposable database — this suite drops and recreates schema (destructive). Never point
// it at production; never reuse the production DATABASE_URL for it.
//
// Skip policy: if TEST_DATABASE_URL is absent and REQUIRE_REAL_PG=1 (CI), the suite fails
// loudly rather than silently skipping. Locally, it skips with a clear message.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import {
  applyMigrations,
  loadMigrations,
  migrationStatus,
  migrationChecksum,
  MigrationChecksumError,
  PostgresAuditRepository,
  PostgresSnapshotRepository,
  PostgresCheckpointRepository,
  PostgresSteeringStateRepository,
  PostgresSteeringEventRepository,
  PostgresDnsObservationRepository,
  PostgresValidationResultRepository,
  type NewSteeringState,
  type NewDnsObservation,
  type NewValidationResult,
  type Queryable,
} from '../../src/index.js';

const URL = process.env.TEST_DATABASE_URL;
if (!URL) {
  if (process.env.REQUIRE_REAL_PG === '1') {
    throw new Error(
      'TEST_DATABASE_URL is required (REQUIRE_REAL_PG=1) but is not set — refusing to silently skip real-PostgreSQL validation.',
    );
  }
  console.warn('\n[integration] SKIPPING real-PostgreSQL suite: set TEST_DATABASE_URL to run it.\n');
}

const ADVISORY_KEY = 5203071;

const sampleSnapshot = {
  sourceSystem: 'ns1',
  resourceKind: 'record',
  resourceKey: 'live.rte.ie/A',
  sourceEndpoint: 'https://api.nsone.net/v1/zones/rte.ie/live.rte.ie/A',
  retrievedAt: new Date('2026-07-01T10:00:00.000Z'),
  createdBySubject: 'user-oid-1',
  label: 'demo capture',
  rawPayload: { answers: [{ answer: ['réalta'], meta: { up: true, weight: 70, asn: [5466, 15502] } }], nested: { a: { b: [1, 2, { c: '✓' }] } } },
  canonicalPayload: { answers: ['réalta'] },
  rawChecksum: 'sha256:abc',
  structuralChecksum: 'sha256:struct',
  metadata: { note: 'nested ✓', tags: ['a', 'b'] },
};

describe.skipIf(!URL)('real PostgreSQL persistence', () => {
  let pool: pg.Pool;
  const q = (): Queryable => pool as unknown as Queryable;
  const reset = () =>
    pool.query(
      'DROP TABLE IF EXISTS configuration_snapshots, audit_events, change_detection_checkpoints, live_steering_states, steering_change_events, dns_observations, ns1_validation_results, schema_migrations CASCADE',
    );
  const migrate = async () => {
    const c = await pool.connect();
    try {
      return await applyMigrations(c, loadMigrations());
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 8 });
  });
  afterAll(async () => {
    await pool.end();
  });

  // ----- Migration runner (section 5) --------------------------------------
  describe('migration runner', () => {
    beforeEach(reset);

    it('bootstraps schema_migrations, applies migrations in lexical order with timing', async () => {
      const applied = await migrate();
      expect(applied).toEqual(['0001_init', '0002_live_steering', '0003_dns_observations', '0004_ns1_validations', '0005_connector_settings']);
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_migrations'`,
      );
      const names = cols.rows.map((r) => r.column_name);
      for (const n of ['version', 'filename', 'checksum', 'applied_at', 'execution_ms']) expect(names).toContain(n);
      const rec = await pool.query<{ filename: string; checksum: string; execution_ms: number }>(
        `SELECT filename, checksum, execution_ms FROM schema_migrations WHERE version = '0001_init'`,
      );
      expect(rec.rows[0].filename).toBe('0001_init.sql');
      expect(rec.rows[0].checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(typeof rec.rows[0].execution_ms).toBe('number');
      const files = loadMigrations().map((m) => m.filename);
      expect(files).toEqual([...files].sort()); // deterministic lexical ordering
    });

    it('is idempotent on re-run', async () => {
      await migrate();
      expect(await migrate()).toEqual([]);
    });

    it('reports applied and pending migrations correctly', async () => {
      await migrate();
      const withPending = [
        ...loadMigrations(),
        { version: '0002_pending', filename: '0002_pending.sql', sql: 'SELECT 1;', checksum: migrationChecksum('SELECT 1;') },
      ];
      const c = await pool.connect();
      try {
        const status = await migrationStatus(c, withPending);
        expect(status.find((s) => s.version === '0001_init')).toMatchObject({ applied: true, checksumMatches: true });
        expect(status.find((s) => s.version === '0002_pending')).toMatchObject({ applied: false, checksumMatches: null });
      } finally {
        c.release();
      }
    });

    it('rejects an already-applied migration whose file checksum changed', async () => {
      await migrate();
      const tampered = loadMigrations().map((m) => ({ ...m, checksum: migrationChecksum(`${m.sql}\n-- altered`) }));
      const c = await pool.connect();
      try {
        await expect(applyMigrations(c, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
      } finally {
        c.release();
      }
    });

    it('rolls a failed migration back and does not record it (each migration transactional)', async () => {
      await migrate();
      const bad = [
        ...loadMigrations(),
        {
          version: '9999_bad',
          filename: '9999_bad.sql',
          sql: 'CREATE TABLE ok_tbl (x int); INSERT INTO does_not_exist VALUES (1);',
          checksum: migrationChecksum('bad'),
        },
      ];
      const c = await pool.connect();
      try {
        await expect(applyMigrations(c, bad)).rejects.toThrow();
      } finally {
        c.release();
      }
      const recorded = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '9999_bad'`);
      expect(recorded.rowCount).toBe(0);
      // The CREATE TABLE that preceded the failing statement was rolled back too.
      const tbl = await pool.query<{ t: string | null }>(`SELECT to_regclass('public.ok_tbl') AS t`);
      expect(tbl.rows[0].t).toBeNull();
    });

    it('advisory lock serialises two concurrent runners (applied exactly once)', async () => {
      const runOnce = async () => {
        const c = await pool.connect();
        try {
          await c.query('SELECT pg_advisory_lock($1)', [ADVISORY_KEY]);
          return await applyMigrations(c, loadMigrations());
        } finally {
          await c.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]).catch(() => undefined);
          c.release();
        }
      };
      const [a, b] = await Promise.all([runOnce(), runOnce()]);
      expect([a.length, b.length].sort()).toEqual([0, 4]); // one applied all, the other found them applied
      const count = await pool.query<{ n: number }>('SELECT count(*)::int n FROM schema_migrations');
      expect(count.rows[0].n).toBe(4); // no duplicate
    });

    it('releases the advisory lock after success and after failure', async () => {
      const canAcquire = async (): Promise<boolean> => {
        const other = await pool.connect();
        try {
          const r = await other.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_KEY]);
          if (r.rows[0].got) await other.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]);
          return r.rows[0].got;
        } finally {
          other.release();
        }
      };
      // success path
      let c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock($1)', [ADVISORY_KEY]);
        await applyMigrations(c, loadMigrations());
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]);
        c.release();
      }
      expect(await canAcquire()).toBe(true);
      // failure path
      const bad = [...loadMigrations(), { version: '9999_bad', filename: '9999_bad.sql', sql: 'NOT SQL;', checksum: migrationChecksum('NOT SQL;') }];
      c = await pool.connect();
      let threw = false;
      try {
        await c.query('SELECT pg_advisory_lock($1)', [ADVISORY_KEY]);
        await applyMigrations(c, bad);
      } catch {
        threw = true;
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]).catch(() => undefined);
        c.release();
      }
      expect(threw).toBe(true);
      expect(await canAcquire()).toBe(true);
    });
  });

  // ----- Schema catalog verification (section 6) ---------------------------
  describe('schema catalog', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });

    it('configuration_snapshots has the required columns, types, constraints and indexes', async () => {
      const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'configuration_snapshots'`,
      );
      const by = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
      for (const c of ['id', 'source_system', 'resource_kind', 'resource_key', 'source_endpoint', 'retrieved_at', 'created_at', 'created_by_subject', 'label', 'raw_payload', 'canonical_payload', 'raw_checksum', 'structural_checksum', 'metadata']) {
        expect(by[c]).toBeDefined();
      }
      expect(by.id.data_type).toBe('uuid');
      expect(by.raw_payload.data_type).toBe('jsonb');
      expect(by.canonical_payload.data_type).toBe('jsonb');
      expect(by.metadata.data_type).toBe('jsonb');
      expect(by.retrieved_at.data_type).toBe('timestamp with time zone');
      expect(by.created_at.data_type).toBe('timestamp with time zone');
      expect(by.source_system.is_nullable).toBe('NO');
      expect(by.metadata.column_default).toContain('{}'); // default present
      expect(by.created_at.column_default).toContain('now()');

      const pk = await pool.query<{ column_name: string }>(
        `SELECT a.attname AS column_name FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'configuration_snapshots'::regclass AND i.indisprimary`,
      );
      expect(pk.rows.map((r) => r.column_name)).toEqual(['id']);

      const idx = await pool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'configuration_snapshots'`);
      const names = idx.rows.map((r) => r.indexname);
      for (const n of ['idx_snapshots_resource', 'idx_snapshots_source', 'idx_snapshots_checksum', 'idx_snapshots_created']) expect(names).toContain(n);
    });

    it('audit_events has actor_roles as a PostgreSQL array, jsonb details, constraints and indexes', async () => {
      const cols = await pool.query<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'audit_events'`,
      );
      const by = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
      for (const c of ['id', 'occurred_at', 'actor_subject', 'actor_roles', 'authentication_method', 'action', 'resource_type', 'resource_key', 'outcome', 'correlation_id', 'details']) {
        expect(by[c]).toBeDefined();
      }
      expect(by.id.data_type).toBe('uuid');
      expect(by.actor_roles.data_type).toBe('ARRAY');
      expect(by.actor_roles.udt_name).toBe('_text'); // text[]
      expect(by.details.data_type).toBe('jsonb');
      expect(by.occurred_at.data_type).toBe('timestamp with time zone');
      expect(by.action.is_nullable).toBe('NO');
      expect(by.outcome.is_nullable).toBe('NO');
      expect(by.actor_roles.column_default).toContain('{}');

      const idx = await pool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events'`);
      const names = idx.rows.map((r) => r.indexname);
      for (const n of ['idx_audit_occurred', 'idx_audit_actor', 'idx_audit_action', 'idx_audit_resource', 'idx_audit_correlation']) expect(names).toContain(n);
    });

    it('schema_migrations has version primary key plus filename, checksum, applied_at, execution_ms', async () => {
      const pk = await pool.query<{ column_name: string }>(
        `SELECT a.attname AS column_name FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'schema_migrations'::regclass AND i.indisprimary`,
      );
      expect(pk.rows.map((r) => r.column_name)).toEqual(['version']);
      const cols = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_migrations'`);
      for (const n of ['version', 'filename', 'checksum', 'applied_at', 'execution_ms']) expect(cols.rows.map((r) => r.column_name)).toContain(n);
    });
  });

  // ----- Repositories (section 7) ------------------------------------------
  describe('snapshot repository', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });
    afterEach(() => pool.query('TRUNCATE configuration_snapshots'));

    it('creates, gets by id, and returns null for a missing id', async () => {
      const repo = new PostgresSnapshotRepository(q());
      const created = await repo.create(sampleSnapshot);
      const fetched = await repo.getById(created.id);
      expect(fetched?.resourceKey).toBe('live.rte.ie/A');
      expect(await repo.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('preserves raw/canonical/nested/array JSON, a JSON scalar, metadata, unicode and timestamps', async () => {
      const repo = new PostgresSnapshotRepository(q());
      const created = await repo.create(sampleSnapshot);
      const fetched = await repo.getById(created.id);
      expect(fetched?.rawPayload).toEqual(sampleSnapshot.rawPayload); // semantic JSON equality
      expect(fetched?.canonicalPayload).toEqual(sampleSnapshot.canonicalPayload);
      expect(fetched?.metadata).toEqual(sampleSnapshot.metadata);
      expect(fetched?.retrievedAt.toISOString()).toBe('2026-07-01T10:00:00.000Z');
      expect(fetched?.createdAt).toBeInstanceOf(Date);
      // JSON scalar payload
      const scalar = await repo.create({ ...sampleSnapshot, rawPayload: 42, canonicalPayload: 'réalta' });
      const s = await repo.getById(scalar.id);
      expect(s?.rawPayload).toBe(42);
      expect(s?.canonicalPayload).toBe('réalta');
    });

    it('treats nullable/omitted optional fields as undefined and metadata as {}', async () => {
      const repo = new PostgresSnapshotRepository(q());
      const created = await repo.create({
        sourceSystem: 'ns1',
        resourceKind: 'zone',
        resourceKey: 'rte.ie',
        retrievedAt: new Date('2026-07-02T00:00:00.000Z'),
        rawPayload: { a: 1 },
        canonicalPayload: { a: 1 },
        rawChecksum: 'sha256:z',
      });
      const fetched = await repo.getById(created.id);
      expect(fetched?.structuralChecksum).toBeUndefined();
      expect(fetched?.sourceEndpoint).toBeUndefined();
      expect(fetched?.label).toBeUndefined();
      expect(fetched?.metadata).toEqual({});
    });

    it('lists by source/kind/key/checksum, filters by retrieval time, bounds limits, orders newest first', async () => {
      const repo = new PostgresSnapshotRepository(q());
      await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-01T00:00:00.000Z'), rawChecksum: 'sha256:one' });
      await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-03T00:00:00.000Z'), rawChecksum: 'sha256:two' });
      await repo.create({ ...sampleSnapshot, resourceKey: 'other/A', sourceSystem: 'other', rawChecksum: 'sha256:three' });
      expect(await repo.list({ sourceSystem: 'ns1' })).toHaveLength(2);
      expect(await repo.list({ resourceKind: 'record' })).toHaveLength(3);
      expect(await repo.list({ resourceKey: 'other/A' })).toHaveLength(1);
      expect(await repo.list({ rawChecksum: 'sha256:two' })).toHaveLength(1);
      expect(await repo.list({ retrievedSince: new Date('2026-07-02T00:00:00.000Z') })).toHaveLength(1);
      const ns1 = await repo.list({ sourceSystem: 'ns1' });
      expect(ns1[0].retrievedAt.toISOString()).toBe('2026-07-03T00:00:00.000Z');
      expect(await repo.list({ limit: 1 })).toHaveLength(1);
    });
  });

  describe('audit repository', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });
    afterEach(() => pool.query('TRUNCATE audit_events'));

    it('appends and preserves role arrays, JSON details and unicode; filters and orders', async () => {
      const repo = new PostgresAuditRepository(q());
      await repo.record({ actorSubject: 'a', actorRoles: ['ENGINEER', 'NOC_VIEWER'], action: 'snapshot.create', resourceType: 'record', resourceKey: 'live.rte.ie/A', outcome: 'success', correlationId: 'c-1', details: { note: 'réalta ✓', nested: { x: [1, 2] } } });
      await repo.record({ actorSubject: 'b', action: 'auth.login', outcome: 'failure', correlationId: 'c-2' });

      const [first] = await repo.list({ correlationId: 'c-1' });
      expect(first.actorRoles).toEqual(['ENGINEER', 'NOC_VIEWER']);
      expect(first.details).toEqual({ note: 'réalta ✓', nested: { x: [1, 2] } });

      const [login] = await repo.list({ actorSubject: 'b' });
      expect(login.actorRoles).toEqual([]); // nullable/default optional fields
      expect(login.details).toEqual({});
      expect(login.resourceType).toBeUndefined();

      expect(await repo.list({ action: 'snapshot.create' })).toHaveLength(1);
      expect(await repo.list({ resourceKey: 'live.rte.ie/A' })).toHaveLength(1);
      expect(await repo.list({ limit: 1 })).toHaveLength(1);
      const all = await repo.list({});
      expect(all[0].occurredAt.getTime()).toBeGreaterThanOrEqual(all[1].occurredAt.getTime()); // newest first
    });
  });

  // ----- Live Steering: checkpoint, state & event repositories -------------
  describe('steering repositories', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });
    afterEach(() => pool.query('TRUNCATE change_detection_checkpoints, live_steering_states, steering_change_events'));

    const state = (over: Partial<NewSteeringState> = {}): NewSteeringState => ({
      ispId: 'eir',
      resourceKey: 'rte.ie/live.rte.ie/A',
      ispName: 'Eir',
      asn: 5466,
      fingerprint: 'fp-1',
      identitySource: 'ecs',
      country: 'IE',
      matchedPrefix: '185.2.100.0/24',
      preferredPath: 'Eir PNI',
      eligibleAnswerIds: ['ans-realta', 'ans-fastly'],
      distribution: [
        { answerId: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', share: 0.7 },
        { answerId: 'ans-fastly', label: 'Fastly', deliveryPlatform: 'Fastly', share: 0.3 },
      ],
      filterChain: ['up', 'weighted_shuffle'],
      complete: true,
          structuralChecksum: 'sha256:aaaa',
      evaluatedAt: new Date('2026-07-11T10:00:00.000Z'),
      ...over,
    });

    it('checkpoint upserts by source, survives (durable) and updates in place — one row per source', async () => {
      const repo = new PostgresCheckpointRepository(q());
      expect(await repo.get('ns1-activity-poll')).toBeNull();
      await repo.upsert('ns1-activity-poll', 'act-10', new Date('2026-07-11T10:00:00.000Z'));
      // A fresh repository instance reads the durable row (simulates a process restart).
      const reread = new PostgresCheckpointRepository(q());
      const cp = await reread.get('ns1-activity-poll');
      expect(cp?.checkpointId).toBe('act-10');
      expect(cp?.checkpointOccurredAt?.toISOString()).toBe('2026-07-11T10:00:00.000Z');
      // Advancing overwrites the same source row (no duplicate PK).
      await repo.upsert('ns1-activity-poll', 'act-20', new Date('2026-07-11T11:00:00.000Z'));
      const rows = await pool.query<{ n: number }>("SELECT count(*)::int n FROM change_detection_checkpoints WHERE source = 'ns1-activity-poll'");
      expect(rows.rows[0].n).toBe(1);
      expect((await repo.get('ns1-activity-poll'))?.checkpointId).toBe('act-20');
    });

    it('steering state upserts on (isp_id, resource_key), preserves JSON, filters and bounds', async () => {
      const repo = new PostgresSteeringStateRepository(q());
      await repo.upsert(state());
      await repo.upsert(state({ ispId: 'virgin', ispName: 'Virgin Media', asn: 6830, fingerprint: 'fp-v' }));
      // Upsert the same key again → still one row, updated fingerprint + fresh updatedAt.
      await repo.upsert(state({ fingerprint: 'fp-2', eligibleAnswerIds: ['ans-fastly'] }));

      const eir = await repo.get('eir', 'rte.ie/live.rte.ie/A');
      expect(eir?.fingerprint).toBe('fp-2');
      expect(eir?.eligibleAnswerIds).toEqual(['ans-fastly']);
      expect(eir?.distribution).toEqual(state().distribution); // jsonb round-trips structurally
      expect(eir?.evaluatedAt).toBeInstanceOf(Date);
      expect(eir?.updatedAt).toBeInstanceOf(Date);

      expect(await repo.list()).toHaveLength(2); // one per ISP, not per upsert
      expect(await repo.list({ ispId: 'eir' })).toHaveLength(1);
      expect(await repo.list({ asn: 6830 })).toHaveLength(1);
      expect(await repo.list({ resourceKey: 'rte.ie/live.rte.ie/A' })).toHaveLength(2);
    });

    it('persists steering-change events with full previous/current state and filters by isp/asn/since/before/limit, newest first', async () => {
      const repo = new PostgresSteeringEventRepository(q());
      const prev = state({ fingerprint: 'fp-1' });
      const curr = state({ fingerprint: 'fp-2', eligibleAnswerIds: ['ans-fastly'] });
      const e1 = await repo.create({
        ispId: 'eir', ispName: 'Eir', asn: 5466, resourceKey: 'rte.ie/live.rte.ie/A', reason: 'answer_became_unavailable',
        previousFingerprint: 'fp-1', currentFingerprint: 'fp-2', previousState: prev, currentState: curr,
        previousChecksum: 'sha256:aaaa', currentChecksum: 'sha256:bbbb', activity: { action: 'update' }, occurredAt: new Date('2026-07-11T10:00:00.000Z'),
      });
      expect(e1.id).toMatch(/^[0-9a-f-]{36}$/);
      await repo.create({
        ispId: 'virgin', ispName: 'Virgin Media', asn: 6830, resourceKey: 'rte.ie/live.rte.ie/A', reason: 'expected_weight_changed',
        currentFingerprint: 'fp-v2', currentState: curr, activity: {}, occurredAt: new Date('2026-07-11T11:00:00.000Z'),
      });

      const all = await repo.list();
      expect(all).toHaveLength(2);
      expect(all[0].occurredAt.getTime()).toBeGreaterThan(all[1].occurredAt.getTime()); // newest first
      const eir = await repo.list({ ispId: 'eir' });
      expect(eir).toHaveLength(1);
      expect(eir[0].reason).toBe('answer_became_unavailable');
      expect(eir[0].previousState).toEqual(JSON.parse(JSON.stringify(prev))); // full state jsonb round-trips (Dates → ISO strings)
      expect(eir[0].currentChecksum).toBe('sha256:bbbb');
      expect(await repo.list({ asn: 6830 })).toHaveLength(1);
      expect(await repo.list({ since: new Date('2026-07-11T10:30:00.000Z') })).toHaveLength(1);
      expect(await repo.list({ before: new Date('2026-07-11T10:30:00.000Z') })).toHaveLength(1);
      expect(await repo.list({ limit: 1 })).toHaveLength(1);
    });
  });

  // ----- DNS observation repository ----------------------------------------
  describe('dns observation repository', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });
    afterEach(() => pool.query('TRUNCATE dns_observations'));

    const obs = (over: Partial<NewDnsObservation> = {}): NewDnsObservation => ({
      ispId: 'eir', ispName: 'Eir', asn: 5466, resolverIp: '192.0.2.11', zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A',
      ecsRequested: true, ecsPrefix: '203.0.113.0/24', ecsHonoured: true, responseCode: 'NOERROR',
      observedAnswers: [{ type: 'A', address: '192.0.2.10' }], predictedAnswers: [{ answerId: 'ans-realta', addresses: ['192.0.2.10'] }],
      comparisonStatus: 'match', confidence: 'medium', ttl: 30, latencyMs: 12, recordChecksum: 'sha256:aaaa',
      explanation: 'ok ✓', warnings: ['réalta note'], provenance: { source: 'radar', label: 'Observed DNS answer', differences: [] }, correlationId: 'corr-1',
      ...over,
    });

    it('persists observations with JSONB round-trip, filters, bounds and latest-per-ISP; no secrets stored', async () => {
      const repo = new PostgresDnsObservationRepository(q());
      const created = await repo.create(obs());
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.observedAnswers).toEqual([{ type: 'A', address: '192.0.2.10' }]);
      expect(created.provenance).toEqual({ source: 'radar', label: 'Observed DNS answer', differences: [] });
      expect(created.warnings).toEqual(['réalta note']); // unicode preserved

      await repo.create(obs({ comparisonStatus: 'mismatch', responseCode: 'NXDOMAIN', observedAnswers: [] }));
      await repo.create(obs({ ispId: 'virgin', ispName: 'Virgin', asn: 6830 }));

      expect(await repo.list()).toHaveLength(3);
      expect(await repo.list({ ispId: 'eir' })).toHaveLength(2);
      expect(await repo.list({ comparisonStatus: 'mismatch' })).toHaveLength(1);
      expect(await repo.list({ recordChecksum: 'sha256:aaaa' })).toHaveLength(3);
      expect(await repo.list({ limit: 1 })).toHaveLength(1);
      const all = await repo.list({});
      expect(all[0].observedAt.getTime()).toBeGreaterThanOrEqual(all[1].observedAt.getTime()); // newest first

      const latest = await repo.latestPerIsp();
      expect(latest.map((r) => r.ispId).sort()).toEqual(['eir', 'virgin']); // one row per ISP

      // No credential-like content is present in stored rows.
      const dump = JSON.stringify(await repo.list());
      expect(dump.toLowerCase()).not.toMatch(/token|secret|password|api[_-]?key/);
    });
  });

  // ----- NS1 validation repository -----------------------------------------
  describe('ns1 validation repository', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });
    afterEach(() => pool.query('TRUNCATE ns1_validation_results'));

    const val = (over: Partial<NewValidationResult> = {}): NewValidationResult => ({
      endpoint: 'record', zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A', sourceMode: 'live',
      retrievedAt: new Date('2026-07-12T10:00:00.000Z'), rawChecksum: 'sha256:aaaa', structuralChecksum: 'sha256:bbbb',
      overallStatus: 'compatible_with_warnings', schemaCompatible: true, adapterCompatible: true,
      supportedFilters: ['up', 'weighted_shuffle'], unsupportedFilters: [],
      unknownFields: { metadata: ['mystery ✓'], unexpected: [], features: [] }, missingFields: [], typeMismatches: [],
      answerGroupsPresent: false, feedControlledPresent: true, ecs: { present: true, enabled: true },
      fixtureComparison: { provisionalFixtureFields: ['answers[].meta.asn'], liveOnlyFields: [], typeMismatches: [], matches: false },
      warnings: ['réalta note'], sanitisedSample: { id: 'r', apiKey: '[REDACTED]' }, correlationId: 'corr-1', ...over,
    });

    it('persists results with JSONB round-trip, getById, filters, bounds; stores no credentials', async () => {
      const repo = new PostgresValidationResultRepository(q());
      const created = await repo.create(val());
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.ecs).toEqual({ present: true, enabled: true });
      expect(created.sanitisedSample).toEqual({ id: 'r', apiKey: '[REDACTED]' });
      expect((created.unknownFields as { metadata: string[] }).metadata).toEqual(['mystery ✓']); // unicode preserved
      expect(await repo.getById(created.id)).not.toBeNull();

      await repo.create(val({ overallStatus: 'incompatible', schemaCompatible: false }));
      await repo.create(val({ endpoint: 'zone', domain: undefined, recordType: undefined }));
      expect(await repo.list()).toHaveLength(3);
      expect(await repo.list({ overallStatus: 'incompatible' })).toHaveLength(1);
      expect(await repo.list({ endpoint: 'record' })).toHaveLength(2);
      expect(await repo.list({ rawChecksum: 'sha256:aaaa' })).toHaveLength(3);
      expect(await repo.list({ limit: 1 })).toHaveLength(1);
      const all = await repo.list({});
      expect(all[0].ranAt.getTime()).toBeGreaterThanOrEqual(all[1].ranAt.getTime()); // newest first

      const dump = JSON.stringify(await repo.list());
      expect(dump.toLowerCase()).not.toMatch(/super-secret|bearer .*token/);
    });
  });

  // ----- Transactions & connection handling (section 8) --------------------
  describe('transactions and connection handling', () => {
    beforeAll(async () => {
      await reset();
      await migrate();
    });
    afterEach(() => pool.query('TRUNCATE configuration_snapshots'));

    it('commits on success and rolls back on failure with no partial state', async () => {
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

    it('supports savepoint-based partial rollback (nested-transaction semantics)', async () => {
      const poolRepo = new PostgresSnapshotRepository(q());
      const client = await pool.connect();
      try {
        const txRepo = new PostgresSnapshotRepository(client as unknown as Queryable);
        await client.query('BEGIN');
        const outer = await txRepo.create(sampleSnapshot);
        await client.query('SAVEPOINT sp1');
        const inner = await txRepo.create({ ...sampleSnapshot, resourceKey: 'inner/A' });
        await client.query('ROLLBACK TO SAVEPOINT sp1');
        await client.query('COMMIT');
        expect(await poolRepo.getById(outer.id)).not.toBeNull();
        expect(await poolRepo.getById(inner.id)).toBeNull();
      } finally {
        client.release();
      }
    });

    it('a statement timeout surfaces the safe query_canceled category (57014)', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 150');
        await expect(client.query('SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
      } finally {
        client.release();
      }
    });

    it('keeps the pool usable after a query error (client released on failure)', async () => {
      const client = await pool.connect();
      try {
        await client.query('SELECT * FROM does_not_exist').catch(() => undefined);
      } finally {
        client.release();
      }
      const c2 = await pool.connect();
      try {
        const r = await c2.query<{ ok: number }>('SELECT 1 AS ok');
        expect(r.rows[0].ok).toBe(1);
      } finally {
        c2.release();
      }
    });
  });
});

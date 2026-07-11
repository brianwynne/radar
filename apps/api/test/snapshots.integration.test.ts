// Snapshot persistence and atomic audit against a REAL PostgreSQL server. Skipped unless
// TEST_DATABASE_URL is set; fails loudly under REQUIRE_REAL_PG=1 (CI).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { applyMigrations, loadMigrations } from '@radar/data';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database/repositories.js';

const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_REAL_PG === '1') {
  throw new Error('TEST_DATABASE_URL is required (REQUIRE_REAL_PG=1) but is not set — refusing to skip.');
}

const sample = {
  sourceSystem: 'ns1',
  resourceKind: 'record',
  resourceKey: 'rte.ie/live.rte.ie/A',
  retrievedAt: new Date('2026-07-01T10:00:00.000Z'),
  rawPayload: { domain: 'live.rte.ie', answers: [{ id: 'a', answer: ['192.0.2.10'] }] },
  canonicalPayload: { answers: [{ answer: ['192.0.2.10'], id: 'a' }], domain: 'live.rte.ie' },
  rawChecksum: 'sha256:raw',
  structuralChecksum: 'sha256:struct',
};

describe.skipIf(!URL)('snapshots against real PostgreSQL', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 6 });
    await pool.query('DROP TABLE IF EXISTS configuration_snapshots, audit_events, schema_migrations CASCADE');
    const c = await pool.connect();
    try {
      await applyMigrations(c, loadMigrations());
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE configuration_snapshots, audit_events');
  });

  it('commits a snapshot and its audit event together', async () => {
    const db = createDatabase(pool);
    await db.transaction(async (repos) => {
      const snap = await repos.snapshots.create(sample);
      await repos.audit.record({ action: 'snapshot.create', outcome: 'success', resourceType: 'record', resourceKey: sample.resourceKey, details: { snapshotId: snap.id } });
    });
    expect((await pool.query('SELECT count(*)::int n FROM configuration_snapshots')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM audit_events')).rows[0].n).toBe(1);
  });

  it('rolls back the snapshot if the audit write (or anything) fails — atomic', async () => {
    const db = createDatabase(pool);
    await expect(
      db.transaction(async (repos) => {
        await repos.snapshots.create(sample);
        throw new Error('boom after snapshot insert');
      }),
    ).rejects.toThrow(/boom/);
    // Neither row survives.
    expect((await pool.query('SELECT count(*)::int n FROM configuration_snapshots')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM audit_events')).rows[0].n).toBe(0);
  });

  it('round-trips raw + canonical payloads and checksums', async () => {
    const db = createDatabase(pool);
    const created = await db.snapshots.create(sample);
    const fetched = await db.snapshots.getById(created.id);
    expect(fetched?.rawPayload).toEqual(sample.rawPayload);
    expect(fetched?.canonicalPayload).toEqual(sample.canonicalPayload);
    expect(fetched?.rawChecksum).toBe('sha256:raw');
    expect(fetched?.structuralChecksum).toBe('sha256:struct');
  });

  it('captures via the HTTP route and lists history (mock client, real DB)', async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: URL, RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'ENGINEER' }), {
      database: createDatabase(pool),
    });
    await app.ready();
    const cap = await app.inject({ method: 'POST', url: '/api/v1/ns1/zones/rte.ie/live.rte.ie/A/snapshots' });
    expect(cap.statusCode).toBe(201);
    const id = cap.json().snapshot.id;
    expect(cap.json().snapshot.rawChecksum).toMatch(/^sha256:/);

    const history = await app.inject({ method: 'GET', url: '/api/v1/ns1/zones/rte.ie/live.rte.ie/A/snapshots' });
    expect(history.json().count).toBe(1);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/snapshots/${id}` });
    expect(detail.json().snapshot.rawPayload.domain).toBe('live.rte.ie');
    // The audit event was persisted alongside the snapshot.
    expect((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='snapshot.create'")).rows[0].n).toBe(1);
    await app.close();
  });
});

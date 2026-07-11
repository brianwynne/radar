// RADAR audit query filtering against a REAL PostgreSQL server (parameterised SQL).
// Skipped unless TEST_DATABASE_URL is set; fails loudly under REQUIRE_REAL_PG=1 (CI).
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

describe.skipIf(!URL)('RADAR audit against real PostgreSQL', () => {
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
    await pool.query('TRUNCATE audit_events');
  });

  it('filters by action, outcome and time range, newest-first, parameterised', async () => {
    const db = createDatabase(pool);
    await db.audit.record({ action: 'snapshot.create', outcome: 'success', actorSubject: 'alice', actorRoles: ['ENGINEER'], resourceType: 'record', resourceKey: 'rte.ie/live.rte.ie/A' });
    await db.audit.record({ action: 'snapshot.create', outcome: 'failure', actorSubject: 'bob' });
    await db.audit.record({ action: 'auth.login', outcome: 'success', actorSubject: 'alice' });

    expect((await db.audit.list({ action: 'snapshot.create' })).length).toBe(2);
    expect((await db.audit.list({ outcome: 'failure' })).length).toBe(1);
    expect((await db.audit.list({ actorSubject: 'alice' })).length).toBe(2);

    const all = await db.audit.list({});
    expect(all[0].occurredAt.getTime()).toBeGreaterThanOrEqual(all[1].occurredAt.getTime()); // newest first
    expect(all[0].actorRoles).toBeInstanceOf(Array);

    // Time range: everything is "now", so an early upper bound excludes all.
    const past = new Date(Date.now() - 3600_000);
    expect((await db.audit.list({ occurredAfter: past })).length).toBe(3);
    expect((await db.audit.list({ occurredBefore: past })).length).toBe(0);
  });

  it('serves the same via GET /api/v1/audit with an action filter', async () => {
    const db = createDatabase(pool);
    await db.audit.record({ action: 'snapshot.create', outcome: 'success', actorSubject: 'a' });
    await db.audit.record({ action: 'auth.login', outcome: 'success', actorSubject: 'b' });
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: URL, RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'VIEWING_ENGINEER' }), {
      database: db,
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?action=snapshot.create' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { action: string }[];
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('snapshot.create');
    await app.close();
  });
});

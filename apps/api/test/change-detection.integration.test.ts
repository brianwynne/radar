// Change-detection service against a REAL PostgreSQL server: a detected change captures a
// snapshot and records the audit event (using the mock NS1 client). Skipped unless
// TEST_DATABASE_URL is set; fails loudly under REQUIRE_REAL_PG=1 (CI).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { applyMigrations, loadMigrations } from '@radar/data';
import { createDatabase } from '../src/database/repositories.js';
import { ChangeDetectionService } from '../src/change-detection/index.js';
import type { ChangeEventSource } from '../src/change-detection/index.js';
import { MockNs1ReadClient } from '../src/ns1/index.js';
import type { ActivityItem } from '../src/ns1/activity.js';

const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_REAL_PG === '1') {
  throw new Error('TEST_DATABASE_URL is required (REQUIRE_REAL_PG=1) but is not set — refusing to skip.');
}

const older: ActivityItem = { id: 'a-old', occurredAt: '2026-07-06T00:00:00Z', action: 'view', resourceType: 'zone', resourceKey: 'rte.ie', raw: {} };
const change: ActivityItem = { id: 'a-new', occurredAt: '2026-07-07T00:00:00Z', action: 'update', resourceType: 'record', resourceKey: 'live.rte.ie/A', actor: 'ops', raw: {} };

describe.skipIf(!URL)('change detection against real PostgreSQL', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 4 });
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

  it('persists a snapshot and a steering.change.detected audit event on a relevant change', async () => {
    const entries = { list: [older] as ActivityItem[] };
    const source: ChangeEventSource = { name: 'test', async poll() { return { entries: entries.list }; } };
    const svc = new ChangeDetectionService({ source, client: new MockNs1ReadClient(), database: createDatabase(pool), mode: 'mock' });

    await svc.runOnce(); // baseline
    entries.list = [change, older];
    const r = await svc.runOnce();
    expect(r.processed).toBe(1);

    expect((await pool.query('SELECT count(*)::int n FROM configuration_snapshots')).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='steering.change.detected'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='snapshot.create'")).rows[0].n).toBe(1);
    const snap = (await pool.query('SELECT created_by_subject, resource_key FROM configuration_snapshots')).rows[0];
    expect(snap.created_by_subject).toBe('system:change-detection');
    expect(snap.resource_key).toBe('rte.ie/live.rte.ie/A');
  });
});

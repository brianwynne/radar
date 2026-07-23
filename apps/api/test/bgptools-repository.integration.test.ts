// bgp.tools repositories against a REAL PostgreSQL server (migration 0006). Skipped unless
// TEST_DATABASE_URL is set; fails loudly under REQUIRE_REAL_PG=1 (CI). Covers monitored-prefix
// management, change-log observation dedup + prune, and incident grouping/lifecycle.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  applyMigrations, loadMigrations,
  PostgresBgpToolsMonitoredPrefixRepository,
  PostgresBgpToolsObservationRepository,
  PostgresBgpToolsIncidentRepository,
} from '@radar/data';

const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_REAL_PG === '1') {
  throw new Error('TEST_DATABASE_URL is required (REQUIRE_REAL_PG=1) but is not set — refusing to skip.');
}

describe.skipIf(!URL)('bgp.tools repositories against real PostgreSQL', () => {
  let pool: pg.Pool;
  let prefixes: PostgresBgpToolsMonitoredPrefixRepository;
  let obs: PostgresBgpToolsObservationRepository;
  let incidents: PostgresBgpToolsIncidentRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 6 });
    await pool.query('DROP TABLE IF EXISTS bgptools_observations, bgptools_incidents, bgptools_monitored_prefixes CASCADE');
    await pool.query("DELETE FROM schema_migrations WHERE version = '0006_bgptools'").catch(() => undefined);
    const c = await pool.connect();
    try {
      await applyMigrations(c, loadMigrations());
    } finally {
      c.release();
    }
    prefixes = new PostgresBgpToolsMonitoredPrefixRepository(pool);
    obs = new PostgresBgpToolsObservationRepository(pool);
    incidents = new PostgresBgpToolsIncidentRepository(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE bgptools_observations, bgptools_incidents, bgptools_monitored_prefixes');
  });

  it('upserts, lists and removes monitored prefixes', async () => {
    await prefixes.upsert({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110, description: 'A' });
    await prefixes.upsert({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110, description: 'B' }); // update
    await prefixes.upsert({ prefix: '2001:db8::/32', addressFamily: 'ipv6', expectedOriginAsn: 2110 });
    const list = await prefixes.list();
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.prefix === '203.0.113.0/24')?.description).toBe('B');
    expect(await prefixes.remove('2001:db8::/32')).toBe(true);
    expect(await prefixes.list()).toHaveLength(1);
  });

  it('records an observation only when the origin set changes (change-log)', async () => {
    const at = new Date('2026-07-24T12:00:00Z');
    const first = await obs.record({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', origins: [{ asn: 2110, hits: 90 }], observedAt: at, source: 'mock' });
    expect(first.inserted).toBe(true);
    // Identical origins → skipped.
    const same = await obs.record({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', origins: [{ asn: 2110, hits: 90 }], observedAt: new Date('2026-07-24T12:30:00Z'), source: 'mock' });
    expect(same.inserted).toBe(false);
    // Changed origins → new row.
    const changed = await obs.record({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', origins: [{ asn: 64500, hits: 60 }], observedAt: new Date('2026-07-24T13:00:00Z'), source: 'mock' });
    expect(changed.inserted).toBe(true);
    expect(await obs.list({ prefix: '203.0.113.0/24' })).toHaveLength(2);
  });

  it('prunes observations older than a cutoff', async () => {
    await obs.record({ prefix: 'p', addressFamily: 'ipv4', origins: [{ asn: 1, hits: 1 }], observedAt: new Date('2026-01-01T00:00:00Z'), source: 'mock' });
    await obs.record({ prefix: 'p', addressFamily: 'ipv4', origins: [{ asn: 2, hits: 1 }], observedAt: new Date('2026-07-01T00:00:00Z'), source: 'mock' });
    const removed = await obs.prune(new Date('2026-06-01T00:00:00Z'));
    expect(removed).toBe(1);
    expect(await obs.list({ prefix: 'p' })).toHaveLength(1);
  });

  it('groups repeated observations into one incident and resolves it', async () => {
    const t1 = new Date('2026-07-24T12:00:00Z');
    const t2 = new Date('2026-07-24T12:30:00Z');
    const a = await incidents.openOrUpdate({ prefix: '203.0.113.0/24', kind: 'hijack', severity: 'critical', observedAt: t1, evidence: { r: 1 } });
    expect(a.state).toBe('detected');
    expect(a.observationCount).toBe(1);
    const b = await incidents.openOrUpdate({ prefix: '203.0.113.0/24', kind: 'hijack', severity: 'critical', observedAt: t2, evidence: { r: 2 } });
    expect(b.id).toBe(a.id); // same incident, not a new one
    expect(b.state).toBe('active'); // detected → active on the second observation
    expect(b.observationCount).toBe(2);
    // A different kind on the same prefix is a distinct incident.
    await incidents.openOrUpdate({ prefix: '203.0.113.0/24', kind: 'visibility_loss', severity: 'degraded', observedAt: t2, evidence: {} });
    expect(await incidents.list({ openOnly: true })).toHaveLength(2);
    // Resolve the hijack incident.
    const resolved = await incidents.resolveOpen('203.0.113.0/24', 'hijack', t2);
    expect(resolved?.state).toBe('resolved');
    expect(await incidents.list({ openOnly: true })).toHaveLength(1);
    // A fresh signal after resolution opens a NEW incident (the open-one index is now free).
    const reopened = await incidents.openOrUpdate({ prefix: '203.0.113.0/24', kind: 'hijack', severity: 'critical', observedAt: new Date('2026-07-24T14:00:00Z'), evidence: {} });
    expect(reopened.id).not.toBe(a.id);
  });
});

// FAST supplementary coverage for the bgp.tools repositories (migration 0006) using pg-mem.
// Not authoritative PostgreSQL — the real-server proof is apps/api/test/bgptools-repository
// .integration.test.ts. Here we confirm the schema applies and the repo logic (change-log dedup,
// incident grouping/lifecycle, prefix upsert) behaves.
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import {
  applyMigrations, loadMigrations,
  PostgresBgpToolsMonitoredPrefixRepository,
  PostgresBgpToolsObservationRepository,
  PostgresBgpToolsIncidentRepository,
  originsChecksum,
  type Queryable,
} from '../src/index.js';

async function freshDb(): Promise<Queryable> {
  const mem: IMemoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Queryable;
  await applyMigrations(db, loadMigrations());
  return db;
}

const T1 = new Date('2026-07-24T12:00:00Z');
const T2 = new Date('2026-07-24T12:30:00Z');

describe('bgp.tools repositories (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => { db = await freshDb(); });

  it('originsChecksum is order-independent', () => {
    const a = originsChecksum([{ asn: 1, hits: 5 }, { asn: 2, hits: 9 }]);
    const b = originsChecksum([{ asn: 2, hits: 9 }, { asn: 1, hits: 5 }]);
    expect(a).toBe(b);
    expect(a).not.toBe(originsChecksum([{ asn: 1, hits: 6 }, { asn: 2, hits: 9 }]));
  });

  it('monitored prefixes: upsert updates in place, remove deletes', async () => {
    const repo = new PostgresBgpToolsMonitoredPrefixRepository(db);
    await repo.upsert({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110, description: 'A' });
    await repo.upsert({ prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110, description: 'B' });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].description).toBe('B');
    expect(typeof list[0].expectedOriginAsn).toBe('number');
    expect(await repo.remove('203.0.113.0/24')).toBe(true);
    expect(await repo.list()).toHaveLength(0);
  });

  it('observations: recorded only when the origin set changes', async () => {
    const repo = new PostgresBgpToolsObservationRepository(db);
    const o = (origins: { asn: number; hits: number }[], at: Date) =>
      repo.record({ prefix: 'q', addressFamily: 'ipv4', origins, observedAt: at, source: 'mock' });
    expect((await o([{ asn: 2110, hits: 90 }], T1)).inserted).toBe(true);
    expect((await o([{ asn: 2110, hits: 90 }], T2)).inserted).toBe(false); // identical → skipped
    expect((await o([{ asn: 64500, hits: 60 }], T2)).inserted).toBe(true); // changed → new row
    expect(await repo.list({ prefix: 'q' })).toHaveLength(2);
  });

  it('incidents: grouping, detected→active, resolve, and reopen', async () => {
    const repo = new PostgresBgpToolsIncidentRepository(db);
    const a = await repo.openOrUpdate({ prefix: 'p', kind: 'hijack', severity: 'critical', observedAt: T1, evidence: { r: 1 } });
    expect(a.state).toBe('detected');
    const b = await repo.openOrUpdate({ prefix: 'p', kind: 'hijack', severity: 'critical', observedAt: T2, evidence: { r: 2 } });
    expect(b.id).toBe(a.id);
    expect(b.state).toBe('active');
    expect(b.observationCount).toBe(2);
    // Distinct kind on the same prefix is its own incident.
    await repo.openOrUpdate({ prefix: 'p', kind: 'visibility_loss', severity: 'degraded', observedAt: T2, evidence: {} });
    expect(await repo.list({ openOnly: true })).toHaveLength(2);
    const resolved = await repo.resolveOpen('p', 'hijack', T2);
    expect(resolved?.state).toBe('resolved');
    expect(await repo.list({ openOnly: true })).toHaveLength(1);
    const reopened = await repo.openOrUpdate({ prefix: 'p', kind: 'hijack', severity: 'critical', observedAt: new Date('2026-07-24T14:00:00Z'), evidence: {} });
    expect(reopened.id).not.toBe(a.id);
  });
});

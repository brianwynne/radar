// bgp.tools poller cycle: merge → assess → persist observations → reconcile incidents. Driven
// against the REAL repositories over pg-mem with a fake Prometheus client, so grouping/lifecycle
// and change-log persistence are exercised end to end.
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import {
  applyMigrations, loadMigrations,
  PostgresBgpToolsObservationRepository, PostgresBgpToolsIncidentRepository, type Queryable,
} from '@radar/data';
import { BgpToolsPoller, type BgpToolsPollerConfig } from '../src/bgptools/poller.js';
import type { BgpToolsMetricsClient } from '../src/bgptools/client.js';
import { DEFAULT_THRESHOLDS } from '../src/bgptools/adapter.js';
import type { BgpToolsMetricsSnapshot, MonitoredPrefix, PrefixMetrics } from '../src/bgptools/types.js';

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const AS = 41073;
const MONITORED: MonitoredPrefix[] = [
  { prefix: '185.54.104.0/22', addressFamily: 'ipv4', expectedOriginAsn: AS },
  { prefix: '89.207.57.0/24', addressFamily: 'ipv4', expectedOriginAsn: AS },
];
const CONFIG: BgpToolsPollerConfig = { enabled: true, mode: 'live', thresholds: DEFAULT_THRESHOLDS, fullVisibilityHits: 100, pollIntervalSeconds: 1800 };

const pfx = (prefix: string, visiblePaths: number, upstreams: number[]): PrefixMetrics =>
  ({ prefix, originAsn: AS, visiblePaths, upstreamCount: upstreams.length, upstreams });
const metricsSnap = (prefixes: PrefixMetrics[]): BgpToolsMetricsSnapshot => ({ observedAt: new Date(NOW), prefixes, asns: [] });

class FakeMetrics implements BgpToolsMetricsClient {
  constructor(public snap: BgpToolsMetricsSnapshot) {}
  async fetchMetrics() { return this.snap; }
  async ping() { return { ok: true, detail: 'fake' }; }
}

async function freshDb(): Promise<Queryable> {
  const mem: IMemoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Queryable;
  await applyMigrations(db, loadMigrations());
  return db;
}

function makePoller(db: Queryable, metrics: FakeMetrics) {
  return new BgpToolsPoller({
    observations: new PostgresBgpToolsObservationRepository(db),
    incidents: new PostgresBgpToolsIncidentRepository(db),
    loadMonitored: async () => MONITORED,
    getConfig: () => CONFIG,
    getMetricsClient: () => metrics,
    getTableClient: () => null,
    now: () => NOW,
  });
}

describe('BgpToolsPoller', () => {
  let db: Queryable;
  let incidents: PostgresBgpToolsIncidentRepository;
  beforeEach(async () => { db = await freshDb(); incidents = new PostgresBgpToolsIncidentRepository(db); });

  it('records observations and opens a critical incident for a low-visibility prefix', async () => {
    // /22 healthy (2673 paths), /24 barely visible (2 paths) → critical.
    const metrics = new FakeMetrics(metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299, 6461]), pfx('89.207.57.0/24', 2, [])]));
    const poller = makePoller(db, metrics);
    const snap = await poller.poll();

    expect(snap.overall).toBe('critical');
    expect(snap.counts).toMatchObject({ healthy: 1, critical: 1 });
    const obs = new PostgresBgpToolsObservationRepository(db);
    expect(await obs.list({ prefix: '89.207.57.0/24' })).toHaveLength(1);
    const open = await incidents.list({ openOnly: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ prefix: '89.207.57.0/24', kind: 'visibility_loss', severity: 'critical', state: 'detected' });
    expect(poller.status().overall).toBe('critical');
    expect(poller.status().openIncidentCount).toBe(1);
  });

  it('resolves the incident when the prefix recovers', async () => {
    // /24 low-visibility but with a stable upstream set, so recovery isolates the visibility change.
    const metrics = new FakeMetrics(metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299, 6461]), pfx('89.207.57.0/24', 2, [174, 1299])]));
    const poller = makePoller(db, metrics);
    await poller.poll();
    // /24 recovers to full visibility (upstreams unchanged).
    metrics.snap = metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299, 6461]), pfx('89.207.57.0/24', 2673, [174, 1299])]);
    const snap = await poller.poll();
    expect(snap.overall).toBe('healthy');
    expect(await incidents.list({ openOnly: true })).toHaveLength(0);
    expect(await incidents.list({ state: 'resolved' })).toHaveLength(1);
  });

  it('resolves incidents for prefixes no longer monitored (orphans)', async () => {
    const inc = new PostgresBgpToolsIncidentRepository(db);
    // An incident left open for a prefix that is NOT in the current watch list (e.g. a prior mock run).
    await inc.openOrUpdate({ prefix: '203.0.113.0/24', kind: 'withdrawn', severity: 'critical', observedAt: new Date(NOW - 1000), evidence: {} });
    expect(await inc.list({ openOnly: true })).toHaveLength(1);
    const metrics = new FakeMetrics(metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299, 6461]), pfx('89.207.57.0/24', 2673, [174, 1299])]));
    const poller = new BgpToolsPoller({
      observations: new PostgresBgpToolsObservationRepository(db), incidents: inc,
      loadMonitored: async () => MONITORED, getConfig: () => CONFIG, getMetricsClient: () => metrics, getTableClient: () => null, now: () => NOW,
    });
    await poller.poll();
    expect(await inc.list({ openOnly: true, prefix: '203.0.113.0/24' })).toHaveLength(0); // orphan resolved
    expect(await inc.list({ state: 'resolved', prefix: '203.0.113.0/24' })).toHaveLength(1);
  });

  it('auto-discovers the watch list from the Prometheus feed when none is configured', async () => {
    // No monitored prefixes configured (loadMonitored returns []), but the feed reports two.
    const metrics = new FakeMetrics(metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299, 6461]), pfx('2a00:1ed8::/29', 3667, [174, 1299])]));
    const poller = new BgpToolsPoller({
      observations: new PostgresBgpToolsObservationRepository(db), incidents: new PostgresBgpToolsIncidentRepository(db),
      loadMonitored: async () => [], getConfig: () => CONFIG, getMetricsClient: () => metrics, getTableClient: () => null, now: () => NOW,
    });
    const snap = await poller.poll();
    expect(snap.counts.total).toBe(2); // discovered from the feed
    expect(snap.assessments.map((a) => a.prefix).sort()).toEqual(['185.54.104.0/22', '2a00:1ed8::/29']);
    // The v6 prefix's address family is inferred correctly.
    expect(snap.assessments.find((a) => a.prefix === '2a00:1ed8::/29')!.signals?.addressFamily).toBe('ipv6');
    expect(snap.overall).toBe('healthy');
  });

  it('opens a missing-upstream incident when an upstream disappears (learned baseline)', async () => {
    const metrics = new FakeMetrics(metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299, 6461]), pfx('89.207.57.0/24', 2673, [174, 1299])]));
    const poller = makePoller(db, metrics);
    await poller.poll(); // establish baseline
    // /22 loses upstream 6461.
    metrics.snap = metricsSnap([pfx('185.54.104.0/22', 2673, [174, 1299]), pfx('89.207.57.0/24', 2673, [174, 1299])]);
    await poller.poll();
    const open = await incidents.list({ openOnly: true, prefix: '185.54.104.0/22' });
    expect(open.map((i) => i.kind)).toContain('missing_upstream');
  });
});

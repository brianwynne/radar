// bgp.tools adapter: normalisation + routing-integrity assessment across the documented-core
// scenarios. Deterministic (injected clock), evidence-based, and honest about withdrawn/stale.
import { describe, it, expect } from 'vitest';
import { buildSnapshot, normalizePrefix, assessPrefix, mergeObservations, visibilityBaselines, DEFAULT_THRESHOLDS, type BuildOptions } from '../src/bgptools/adapter.js';
import { MockBgpToolsClient } from '../src/bgptools/mock-client.js';
import { MOCK_MONITORED_PREFIXES, MOCK_FULL_VISIBILITY_HITS, RTE_ORIGIN_ASN, type MockScenario } from '../src/bgptools/fixtures.js';
import type { BgpToolsMetricsSnapshot, MonitoredPrefix, RawRoutingObservation } from '../src/bgptools/types.js';

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const opts = (over: Partial<BuildOptions> = {}): BuildOptions => ({
  now: NOW, fullVisibilityHits: MOCK_FULL_VISIBILITY_HITS, thresholds: DEFAULT_THRESHOLDS, source: 'mock', synthetic: true, ...over,
});
const v4 = MOCK_MONITORED_PREFIXES[0];

async function snapshotFor(scenario: MockScenario) {
  const client = new MockBgpToolsClient({ scenario, now: () => NOW });
  const raws = await client.fetchObservations(MOCK_MONITORED_PREFIXES);
  return buildSnapshot(MOCK_MONITORED_PREFIXES, raws, opts());
}

describe('normalizePrefix — derived signals', () => {
  const raw = (origins: { asn: number; hits: number }[]): RawRoutingObservation => ({ prefix: v4.prefix, addressFamily: 'ipv4', origins, observedAt: new Date(NOW) });

  it('healthy sole expected origin', () => {
    const s = normalizePrefix(v4, raw([{ asn: RTE_ORIGIN_ASN, hits: 90 }]), opts());
    expect(s.observedOriginAsn).toBe(RTE_ORIGIN_ASN);
    expect(s.originAsExpected).toBe(true);
    expect(s.prefixWithdrawn).toBe(false);
    expect(s.unexpectedOrigin).toBe(false);
    expect(s.moas).toBe(false);
    expect(s.prefixVisibilityRatio).toBeCloseTo(0.9);
    expect(s.sourceConfidence).toBe('high');
  });

  it('withdrawn when no origins are observed', () => {
    const s = normalizePrefix(v4, raw([]), opts());
    expect(s.prefixWithdrawn).toBe(true);
    expect(s.observedOriginAsn).toBeNull();
    expect(s.prefixVisibilityRatio).toBeNull();
  });

  it('MOAS + unexpected origin when a foreign ASN also announces it', () => {
    const s = normalizePrefix(v4, raw([{ asn: RTE_ORIGIN_ASN, hits: 80 }, { asn: 64500, hits: 20 }]), opts());
    expect(s.moas).toBe(true);
    expect(s.unexpectedOrigin).toBe(true);
    expect(s.originAsExpected).toBe(false); // expected present but not the sole origin
    expect(s.observedOriginAsn).toBe(RTE_ORIGIN_ASN); // dominant by hits
  });

  it('marks an old observation stale', () => {
    const old = new Date(NOW - (DEFAULT_THRESHOLDS.maxAgeSeconds + 60) * 1000);
    const s = normalizePrefix(v4, { prefix: v4.prefix, addressFamily: 'ipv4', origins: [{ asn: RTE_ORIGIN_ASN, hits: 90 }], observedAt: old }, opts());
    expect(s.stale).toBe(true);
    expect(s.sourceConfidence).toBe('low');
  });
});

describe('assessPrefix — verdict precedence', () => {
  const assess = (origins: { asn: number; hits: number }[], obsAt = new Date(NOW)) =>
    assessPrefix(normalizePrefix(v4, { prefix: v4.prefix, addressFamily: 'ipv4', origins, observedAt: obsAt }, opts()), DEFAULT_THRESHOLDS, NOW);

  it('healthy: sole expected origin at full visibility', () => {
    expect(assess([{ asn: RTE_ORIGIN_ASN, hits: 95 }]).state).toBe('healthy');
  });
  it('critical: withdrawn', () => {
    const a = assess([]);
    expect(a.state).toBe('critical');
    expect(a.reasons[0]).toMatch(/withdrawn/i);
  });
  it('critical: expected origin absent (hijack)', () => {
    const a = assess([{ asn: 64500, hits: 60 }]);
    expect(a.state).toBe('critical');
    expect(a.reasons[0]).toMatch(/hijack|takeover/i);
  });
  it('critical: near-total visibility loss below the critical ratio', () => {
    expect(assess([{ asn: RTE_ORIGIN_ASN, hits: 30 }]).state).toBe('critical'); // 0.30 < 0.5
  });
  it('degraded: partial visibility loss between thresholds', () => {
    expect(assess([{ asn: RTE_ORIGIN_ASN, hits: 70 }]).state).toBe('degraded'); // 0.70
  });
  it('degraded: MOAS with a foreign origin alongside the expected one', () => {
    expect(assess([{ asn: RTE_ORIGIN_ASN, hits: 88 }, { asn: 64500, hits: 20 }]).state).toBe('degraded');
  });
  it('unknown: stale observation cannot be assessed', () => {
    const a = assess([{ asn: RTE_ORIGIN_ASN, hits: 95 }], new Date(NOW - (DEFAULT_THRESHOLDS.maxAgeSeconds + 60) * 1000));
    expect(a.state).toBe('unknown');
  });
});

describe('buildSnapshot — scenario roll-ups', () => {
  it('healthy scenario → overall healthy, both prefixes healthy', async () => {
    const s = await snapshotFor('healthy');
    expect(s.overall).toBe('healthy');
    expect(s.counts).toMatchObject({ healthy: 2, degraded: 0, critical: 0, unknown: 0, total: 2 });
    expect(s.provenance.synthetic).toBe(true);
    expect(s.provenance.readOnly).toBe(true);
  });
  it('partial visibility loss → overall degraded', async () => {
    const s = await snapshotFor('partial_visibility_loss');
    expect(s.overall).toBe('degraded');
    expect(s.counts.degraded).toBe(2);
  });
  it('full withdrawal → overall critical (one critical, one healthy)', async () => {
    const s = await snapshotFor('full_withdrawal');
    expect(s.overall).toBe('critical');
    expect(s.counts).toMatchObject({ critical: 1, healthy: 1 });
  });
  it('unexpected origin → overall critical', async () => {
    const s = await snapshotFor('unexpected_origin');
    expect(s.overall).toBe('critical');
    expect(s.counts.critical).toBe(1);
  });
  it('MOAS partial hijack → overall degraded', async () => {
    const s = await snapshotFor('moas_partial_hijack');
    expect(s.overall).toBe('degraded');
  });
  it('recovery → back to healthy', async () => {
    const s = await snapshotFor('recovery');
    expect(s.overall).toBe('healthy');
  });
  it('no monitored prefixes → overall unknown with a warning', () => {
    const s = buildSnapshot([] as MonitoredPrefix[], [], opts());
    expect(s.overall).toBe('unknown');
    expect(s.warnings.join(' ')).toMatch(/no prefixes/i);
  });
});

describe('Prometheus visibility (paths) + per-family baseline', () => {
  const at = new Date(NOW);
  const mp = (prefix: string, af: 'ipv4' | 'ipv6'): MonitoredPrefix => ({ prefix, addressFamily: af, expectedOriginAsn: RTE_ORIGIN_ASN });
  const raw = (prefix: string, af: 'ipv4' | 'ipv6', visiblePaths: number): RawRoutingObservation =>
    ({ prefix, addressFamily: af, origins: [{ asn: RTE_ORIGIN_ASN, hits: visiblePaths }], observedAt: at, visiblePaths });

  it('derives a per-family baseline and flags a low-visibility prefix critical', () => {
    const monitored = [mp('185.54.104.0/22', 'ipv4'), mp('89.207.57.0/24', 'ipv4'), mp('2a00:1ed8::/29', 'ipv6')];
    const raws = [raw('185.54.104.0/22', 'ipv4', 2673), raw('89.207.57.0/24', 'ipv4', 2), raw('2a00:1ed8::/29', 'ipv6', 3667)];
    expect(visibilityBaselines(raws)).toEqual({ ipv4: 2673, ipv6: 3667 });
    const snap = buildSnapshot(monitored, raws, opts());
    expect(snap.overall).toBe('critical');
    expect(snap.counts).toMatchObject({ critical: 1, healthy: 2 });
    const low = snap.assessments.find((a) => a.prefix === '89.207.57.0/24')!;
    expect(low.state).toBe('critical'); // 2 / 2673 ≈ 0.07% visibility
    expect(low.signals?.visiblePaths).toBe(2);
  });
});

describe('upstream baseline change', () => {
  const at = new Date(NOW);
  const P = MOCK_MONITORED_PREFIXES[0];
  const norm = (upstreams: number[], prior?: number[]) =>
    normalizePrefix(P, { prefix: P.prefix, addressFamily: 'ipv4', origins: [{ asn: RTE_ORIGIN_ASN, hits: 90 }], observedAt: at, upstreams, visiblePaths: 2600 },
      opts({ visibilityBaselineByFamily: { ipv4: 2600 }, priorUpstreams: prior ? new Map([[P.prefix, prior]]) : undefined }));

  it('reports new and missing upstreams vs the learned baseline', () => {
    const s = norm([174, 1299, 3356], [174, 1299, 6461]);
    expect(s.newUpstreams).toEqual([3356]);
    expect(s.missingUpstreams).toEqual([6461]);
    expect(s.observedUpstreams).toEqual([174, 1299, 3356]);
  });

  it('no change signals on the first observation (no baseline)', () => {
    const s = norm([174, 1299]);
    expect(s.newUpstreams).toEqual([]);
    expect(s.missingUpstreams).toEqual([]);
  });
});

describe('mergeObservations (Prometheus + table)', () => {
  const at = new Date(NOW);
  const monitored = MOCK_MONITORED_PREFIXES;
  const metrics: BgpToolsMetricsSnapshot = {
    observedAt: at,
    prefixes: [{ prefix: monitored[0].prefix, originAsn: RTE_ORIGIN_ASN, visiblePaths: 2600, upstreamCount: 2, upstreams: [174, 1299] }],
    asns: [],
  };

  it('takes visibility+upstreams from metrics and an explicit foreign origin from the table', () => {
    const table: RawRoutingObservation[] = [{ prefix: monitored[0].prefix, addressFamily: 'ipv4', origins: [{ asn: RTE_ORIGIN_ASN, hits: 80 }, { asn: 64500, hits: 20 }], observedAt: at }];
    const merged = mergeObservations(monitored, metrics, table, at);
    const m0 = merged.find((m) => m.prefix === monitored[0].prefix)!;
    expect(m0.visiblePaths).toBe(2600);
    expect(m0.upstreams).toEqual([174, 1299]);
    expect(m0.origins).toEqual([{ asn: RTE_ORIGIN_ASN, hits: 80 }, { asn: 64500, hits: 20 }]); // table origins win (MOAS)
  });

  it('synthesises an origin from the metric when the table has none', () => {
    const merged = mergeObservations(monitored, metrics, null, at);
    const m0 = merged.find((m) => m.prefix === monitored[0].prefix)!;
    expect(m0.origins).toEqual([{ asn: RTE_ORIGIN_ASN, hits: 2600 }]);
    // The v6 prefix has no metric and no table → withdrawn (empty origins).
    expect(merged.find((m) => m.prefix === monitored[1].prefix)!.origins).toEqual([]);
  });
});

// Incident planning: assessments → open/update/resolve actions, with grouping, concurrent kinds,
// and problem-shape changes. Uses the real adapter pipeline to produce assessments.
import { describe, it, expect } from 'vitest';
import type { IncidentKind } from '@radar/data';
import { normalizePrefix, assessPrefix, DEFAULT_THRESHOLDS, type BuildOptions } from '../src/bgptools/adapter.js';
import { incidentsFor, planIncidentActions } from '../src/bgptools/incidents.js';
import type { MonitoredPrefix, RawRoutingObservation } from '../src/bgptools/types.js';

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const baseOpts: BuildOptions = { now: NOW, fullVisibilityHits: 100, thresholds: DEFAULT_THRESHOLDS, source: 'mock', synthetic: true };
const P: MonitoredPrefix = { prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110 };

const assess = (origins: { asn: number; hits: number }[], extra: Partial<RawRoutingObservation> = {}, opts: BuildOptions = baseOpts) => {
  const raw: RawRoutingObservation = { prefix: P.prefix, addressFamily: 'ipv4', origins, observedAt: new Date(NOW), ...extra };
  return assessPrefix(normalizePrefix(P, raw, opts), DEFAULT_THRESHOLDS, NOW);
};
const kinds = (a: ReturnType<typeof assess>) => incidentsFor(a, DEFAULT_THRESHOLDS).map((i) => i.kind).sort();

describe('incidentsFor', () => {
  it('maps each problem to its kinds', () => {
    expect(kinds(assess([]))).toEqual(['withdrawn']);
    expect(kinds(assess([{ asn: 64500, hits: 60 }]))).toEqual(['hijack']);
    expect(kinds(assess([{ asn: 2110, hits: 30 }]))).toEqual(['visibility_loss']); // 0.30 critical
    expect(kinds(assess([{ asn: 2110, hits: 70 }]))).toEqual(['visibility_loss']); // 0.70 degraded
    expect(kinds(assess([{ asn: 2110, hits: 88 }, { asn: 64500, hits: 20 }]))).toEqual(['moas']);
    expect(kinds(assess([{ asn: 2110, hits: 95 }]))).toEqual([]); // healthy
  });

  it('emits concurrent kinds — visibility loss AND missing upstream', () => {
    const opts: BuildOptions = { ...baseOpts, priorUpstreams: new Map([[P.prefix, [174, 1299, 6461]]]) };
    const a = assess([{ asn: 2110, hits: 70 }], { upstreams: [174, 1299] }, opts); // vis degraded + lost 6461
    expect(kinds(a)).toEqual(['missing_upstream', 'visibility_loss']);
  });

  it('detects a new upstream', () => {
    const opts: BuildOptions = { ...baseOpts, priorUpstreams: new Map([[P.prefix, [174, 1299]]]) };
    const a = assess([{ asn: 2110, hits: 95 }], { upstreams: [174, 1299, 3356] }, opts);
    expect(kinds(a)).toEqual(['new_upstream']);
  });
});

describe('planIncidentActions', () => {
  const open = (ks: IncidentKind[]) => new Map([[P.prefix, new Set(ks)]]);

  it('opens each active kind', () => {
    const opts: BuildOptions = { ...baseOpts, priorUpstreams: new Map([[P.prefix, [174, 1299, 6461]]]) };
    const a = assess([{ asn: 2110, hits: 70 }], { upstreams: [174, 1299] }, opts);
    const plan = planIncidentActions([a], new Map(), DEFAULT_THRESHOLDS);
    expect(plan.opens.map((o) => o.kind).sort()).toEqual(['missing_upstream', 'visibility_loss']);
    expect(plan.resolves).toHaveLength(0);
  });

  it('resolves an open kind that is no longer active, keeps the still-active one', () => {
    const a = assess([{ asn: 2110, hits: 70 }]); // only visibility_loss now
    const plan = planIncidentActions([a], open(['visibility_loss', 'missing_upstream']), DEFAULT_THRESHOLDS);
    expect(plan.opens.map((o) => o.kind)).toEqual(['visibility_loss']);
    expect(plan.resolves).toEqual([{ prefix: P.prefix, kind: 'missing_upstream' }]);
  });

  it('resolves all open incidents for a recovered (healthy) prefix', () => {
    const plan = planIncidentActions([assess([{ asn: 2110, hits: 95 }])], open(['visibility_loss', 'hijack']), DEFAULT_THRESHOLDS);
    expect(plan.opens).toHaveLength(0);
    expect(plan.resolves.map((r) => r.kind).sort()).toEqual(['hijack', 'visibility_loss']);
  });

  it('leaves open incidents untouched on a stale/unknown assessment', () => {
    const stale = assess([{ asn: 2110, hits: 95 }], { observedAt: new Date(NOW - (DEFAULT_THRESHOLDS.maxAgeSeconds + 60) * 1000) });
    const plan = planIncidentActions([stale], open(['hijack']), DEFAULT_THRESHOLDS);
    expect(plan.opens).toHaveLength(0);
    expect(plan.resolves).toHaveLength(0);
  });
});

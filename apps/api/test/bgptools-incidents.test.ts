// Incident planning: assessments → open/update/resolve actions, with grouping and problem-shape
// changes. Uses the real adapter pipeline to produce assessments.
import { describe, it, expect } from 'vitest';
import type { IncidentKind } from '@radar/data';
import { normalizePrefix, assessPrefix, DEFAULT_THRESHOLDS, type BuildOptions } from '../src/bgptools/adapter.js';
import { primaryIncident, planIncidentActions } from '../src/bgptools/incidents.js';
import type { MonitoredPrefix, RawRoutingObservation } from '../src/bgptools/types.js';

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const opts: BuildOptions = { now: NOW, fullVisibilityHits: 100, thresholds: DEFAULT_THRESHOLDS, source: 'mock', synthetic: true };
const P: MonitoredPrefix = { prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110 };

const assess = (origins: { asn: number; hits: number }[], stale = false) => {
  const obsAt = stale ? new Date(NOW - (DEFAULT_THRESHOLDS.maxAgeSeconds + 60) * 1000) : new Date(NOW);
  const raw: RawRoutingObservation = { prefix: P.prefix, addressFamily: 'ipv4', origins, observedAt: obsAt };
  return assessPrefix(normalizePrefix(P, raw, opts), DEFAULT_THRESHOLDS, NOW);
};

describe('primaryIncident', () => {
  it('maps each problem to its dominant kind + severity', () => {
    expect(primaryIncident(assess([]))).toEqual({ kind: 'withdrawn', severity: 'critical' });
    expect(primaryIncident(assess([{ asn: 64500, hits: 60 }]))).toEqual({ kind: 'hijack', severity: 'critical' });
    expect(primaryIncident(assess([{ asn: 2110, hits: 30 }]))).toEqual({ kind: 'visibility_loss', severity: 'critical' });
    expect(primaryIncident(assess([{ asn: 2110, hits: 70 }]))).toEqual({ kind: 'visibility_loss', severity: 'degraded' });
    expect(primaryIncident(assess([{ asn: 2110, hits: 88 }, { asn: 64500, hits: 20 }]))).toEqual({ kind: 'moas', severity: 'degraded' });
    expect(primaryIncident(assess([{ asn: 2110, hits: 95 }]))).toBeNull(); // healthy
    expect(primaryIncident(assess([{ asn: 2110, hits: 95 }], true))).toBeNull(); // unknown/stale
  });
});

describe('planIncidentActions', () => {
  const open = (kinds: IncidentKind[]) => new Map([[P.prefix, new Set(kinds)]]);

  it('opens a new incident when a problem appears', () => {
    const plan = planIncidentActions([assess([{ asn: 64500, hits: 60 }])], new Map());
    expect(plan.opens).toHaveLength(1);
    expect(plan.opens[0]).toMatchObject({ prefix: P.prefix, kind: 'hijack', severity: 'critical' });
    expect(plan.opens[0].evidence).toMatchObject({ reasons: expect.any(Array) });
    expect(plan.resolves).toHaveLength(0);
  });

  it('resolves all open incidents for a prefix that recovered to healthy', () => {
    const plan = planIncidentActions([assess([{ asn: 2110, hits: 95 }])], open(['visibility_loss']));
    expect(plan.opens).toHaveLength(0);
    expect(plan.resolves).toEqual([{ prefix: P.prefix, kind: 'visibility_loss' }]);
  });

  it('when the problem changes shape, opens the new kind and resolves the old', () => {
    const plan = planIncidentActions([assess([{ asn: 2110, hits: 88 }, { asn: 64500, hits: 20 }])], open(['hijack']));
    expect(plan.opens[0].kind).toBe('moas');
    expect(plan.resolves).toEqual([{ prefix: P.prefix, kind: 'hijack' }]);
  });

  it('leaves open incidents untouched on a stale/unknown assessment', () => {
    const plan = planIncidentActions([assess([{ asn: 2110, hits: 95 }], true)], open(['hijack']));
    expect(plan.opens).toHaveLength(0);
    expect(plan.resolves).toHaveLength(0);
  });
});

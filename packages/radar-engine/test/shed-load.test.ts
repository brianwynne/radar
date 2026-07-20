// shed_load filter — validated against IBM NS1 Connect docs + the ns1-go SDK. A synthetic,
// structural record (not real config): a per-ISP Réalta answer per DC, gated by shed_load on a
// per-DC feed, with an infinitesimal commercial fallback. Proves: idle = no-op (steady parity),
// per-band behaviour (≤low served, mid partial, ≥high removed), cross-DC absorption, and that the
// commercial fallback (no watermarks) is never shed.
import { describe, it, expect } from 'vitest';
import { evaluate, type NS1Record, type Scenario } from '../src/index.js';

// Sky: Réalta at Citywest + Parkwest (watermarks 70/85, feeds sky-cw/sky-pw) + Fastly fallback.
const SKY_ASN = 5607;
const record: NS1Record = {
  zone: 'nsone.rte.ie', domain: 'liveshed.nsone.rte.ie', type: 'CNAME', ttl: 30, use_client_subnet: true,
  answers: [
    { answer: ['liveedge.rte.ie'], meta: { asn: [SKY_ASN], weight: 100, note: 'Réalta Sky CW', low_watermark: 70, high_watermark: 85, loadavg: { feed: 'sky-cw' } } },
    { answer: ['liveedge.rte.ie'], meta: { asn: [SKY_ASN], weight: 100, note: 'Réalta Sky PW', low_watermark: 70, high_watermark: 85, loadavg: { feed: 'sky-pw' } } },
    { answer: ['t.sni.global.fastly.net'], meta: { asn: [SKY_ASN], weight: 0.001, note: 'Fastly Sky' } },
  ],
  filters: [
    { filter: 'netfence_asn', config: { remove_no_asn: '1' } },
    { filter: 'shed_load', config: { metric: 'loadavg' } },
    { filter: 'weighted_shuffle', config: {} },
    { filter: 'select_first_n', config: { N: 1 } },
  ],
};

const sky = (loadOverrides?: Record<string, number>): Scenario => ({
  qname: 'live.rte.ie', qtype: 'CNAME', resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24',
  country: 'IE', asn: SKY_ASN, loadOverrides,
});
const share = (r: ReturnType<typeof evaluate>, platform: string): number =>
  (r.expectedDistribution?.shares ?? []).filter((s) => s.deliveryPlatform === platform).reduce((a, s) => a + s.share, 0);
const shedStep = (r: ReturnType<typeof evaluate>) => r.traces.find((t) => t.type === 'shed_load')!;

describe('shed_load', () => {
  it('is supported now (not partial) and consumes the metric + watermarks', () => {
    const r = evaluate(record, sky());
    expect(r.complete).toBe(true);
    const t = shedStep(r);
    expect(t.supported).toBe(true);
    expect(t.behaviour).toBe('eliminate');
    expect(t.metadataConsumed).toEqual(expect.arrayContaining(['loadavg', 'low_watermark', 'high_watermark']));
  });

  it('feed-driven load with no override → assumed not shedding (steady-state parity = 100% Réalta)', () => {
    const r = evaluate(record, sky());
    expect(Math.round(share(r, 'Réalta') * 100)).toBe(100);
    expect(shedStep(r).confidence).toBe('medium'); // assumed (feed-driven, no runtime feed)
    expect(shedStep(r).warning).toMatch(/assumed not shedding/i);
  });

  it('load ≤ low watermark → served normally', () => {
    const r = evaluate(record, sky({ 'sky-cw': 50, 'sky-pw': 50 }));
    expect(Math.round(share(r, 'Réalta') * 100)).toBe(100);
    for (const o of shedStep(r).outcomes.filter((o) => o.shedProbability !== undefined)) expect(o.shedProbability).toBe(0);
  });

  it('load ≥ high watermark on BOTH DCs → Réalta removed, spills to commercial', () => {
    const r = evaluate(record, sky({ 'sky-cw': 90, 'sky-pw': 91 }));
    expect(share(r, 'Réalta')).toBe(0);
    expect(Math.round(share(r, 'Fastly') * 100)).toBe(100);
    const removed = shedStep(r).outcomes.filter((o) => o.disposition === 'removed');
    expect(removed.length).toBe(2);
    expect(removed.every((o) => o.shedProbability === 1)).toBe(true);
    // The commercial answer has no watermarks and must never be shed.
    expect(shedStep(r).outcomes.find((o) => /not subject/.test(o.reason))).toBeDefined();
  });

  it('cross-DC absorption: one DC hot, the other cool → stays 100% Réalta (via the cool DC)', () => {
    const r = evaluate(record, sky({ 'sky-cw': 95, 'sky-pw': 45 }));
    expect(Math.round(share(r, 'Réalta') * 100)).toBe(100); // Parkwest carries it
    const removed = shedStep(r).outcomes.filter((o) => o.disposition === 'removed');
    expect(removed.length).toBe(1); // only the hot Citywest answer is shed
  });

  it('mid-band → partial shed: probability set, expected share reduced, selection is probabilistic', () => {
    // Both DCs at the midpoint (77.5 of 70–85) → shedProbability 0.5 each.
    const r = evaluate(record, sky({ 'sky-cw': 77.5, 'sky-pw': 77.5 }));
    const partial = shedStep(r).outcomes.filter((o) => o.shedProbability && o.shedProbability > 0 && o.shedProbability < 1);
    expect(partial.length).toBe(2);
    expect(partial[0].shedProbability).toBeCloseTo(0.5, 5);
    // Réalta share falls below 100% but is not gone (Réalta 100·0.5 ×2 vs Fastly 0.001).
    expect(share(r, 'Réalta')).toBeGreaterThan(0.9);
    expect(share(r, 'Réalta')).toBeLessThan(1);
    expect(r.selectionDeterminism).toBe('probabilistic');
  });

  it('answers without watermarks are never subject to shedding', () => {
    const r = evaluate(record, sky({ 'sky-cw': 99, 'sky-pw': 99 }));
    const fastly = shedStep(r).outcomes.find((o) => /not subject/.test(o.reason));
    expect(fastly).toBeDefined();
    expect(fastly!.disposition).toBe('retained');
  });
});

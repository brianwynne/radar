// RIPE adapter: normalisation + operational assessment across healthy / degraded / withdrawn /
// unexpected-origin / RPKI-invalid / source-unavailable, for IPv4 and IPv6. Missing RIPE data is
// unknown, never a withdrawal.
import { describe, it, expect } from 'vitest';
import { fetchPrefix, buildSnapshot, DEFAULT_ASSESS } from '../src/ripe/adapter.js';
import { MockRipestatClient, RTE_ORIGIN, type RipeScenario } from '../src/ripe/fixtures.js';
import type { RipeSourceHealth } from '../src/ripe/types.js';

const NOW = Date.parse('2026-07-24T09:00:00Z');
const client = (scenario: RipeScenario) => new MockRipestatClient({ scenarioFor: () => scenario, now: () => NOW });
const health = async (prefix: string, scenario: RipeScenario) => (await fetchPrefix(client(scenario), prefix, RTE_ORIGIN, DEFAULT_ASSESS, NOW));

describe('assess — operational verdicts', () => {
  it('healthy: expected origin, RPKI valid, strong visibility', async () => {
    const r = await health('89.207.56.0/21', 'healthy');
    expect(r.health).toBe('healthy');
    expect(r.rpkiState).toBe('valid');
    expect(r.originAsExpected).toBe(true);
    expect(Math.round(r.collectorVisibilityPercent!)).toBe(98);
    expect(r.upstreams).toEqual([174]); // ASN before AS41073
    expect(r.cloudVision.localRoutePresent).toBe('unknown'); // correlation not yet available
  });

  it('degraded: materially reduced collector visibility', async () => {
    const r = await health('89.207.56.0/21', 'degraded');
    expect(r.health).toBe('degraded');
    expect(r.reasons.join(' ')).toMatch(/visibility/i);
  });

  it('traffic-engineering: prefix unseen but covering aggregate visible → degraded, NOT withdrawn', async () => {
    const r = await health('89.207.57.0/24', 'withdrawn_with_cover');
    expect(r.health).toBe('degraded');
    expect(r.coveringPrefix).toBe('89.207.56.0/21');
    expect(r.reasons.join(' ')).toMatch(/traffic-engineering|covering/i);
  });

  it('withdrawn: no route and no covering aggregate', async () => {
    const r = await health('89.207.57.0/24', 'withdrawn');
    expect(r.health).toBe('withdrawn');
    expect(r.reasons.join(' ')).toMatch(/withdrawal/i);
  });

  it('critical: unexpected origin (origin anomaly)', async () => {
    const r = await health('89.207.56.0/21', 'unexpected_origin');
    expect(r.health).toBe('critical');
    expect(r.unexpectedOrigin).toBe(true);
    expect(r.reasons[0]).toMatch(/origin anomaly/i);
  });

  it('critical: RPKI invalid', async () => {
    const r = await health('89.207.56.0/21', 'rpki_invalid');
    expect(r.health).toBe('critical');
    expect(r.reasons[0]).toMatch(/RPKI INVALID/i);
  });

  it('unknown: RIPE unavailable is monitoring-degraded, explicitly NOT a withdrawal', async () => {
    const r = await health('89.207.56.0/21', 'unavailable');
    expect(r.health).toBe('unknown');
    expect(r.freshness).toBe('unknown');
    expect(r.partial).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/NOT a route withdrawal/i);
  });

  it('IPv6 healthy prefix with its own upstream', async () => {
    const r = await health('2a00:1ed8::/29', 'healthy');
    expect(r.addressFamily).toBe('ipv6');
    expect(r.health).toBe('healthy');
    expect(r.upstreams).toEqual([1299]);
  });
});

describe('buildSnapshot roll-up', () => {
  it('counts states, RPKI-invalid and unexpected-origin; overall = worst', async () => {
    const prefixes = [
      await health('89.207.56.0/21', 'healthy'),
      await health('185.54.104.0/22', 'degraded'),
      await health('89.207.57.0/24', 'unexpected_origin'),
    ];
    const source: RipeSourceHealth = { ripestatReachable: true, ripestatLastSuccessAt: '2026-07-24T09:00:00Z', ripestatLastError: null, risLiveState: 'disabled', risLiveLastMessageAt: null, status: 'live' };
    const snap = buildSnapshot(prefixes, source, NOW);
    expect(snap.overall).toBe('critical');
    expect(snap.counts).toMatchObject({ healthy: 1, degraded: 1, critical: 1, unexpectedOrigin: 1, rpkiInvalid: 1, total: 3 });
  });
});

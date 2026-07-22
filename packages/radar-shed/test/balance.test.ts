import { describe, it, expect } from 'vitest';
import { balanceForEqualUtilisation, BALANCE_POOLS, type BalancePool } from '../src/index.js';

describe('BALANCE_POOLS policy', () => {
  it('has the four delivery pools with CW/PW higher capacity than Mam/Dad', () => {
    expect(BALANCE_POOLS.map((p) => p.id).sort()).toEqual(['citywest', 'dad', 'mam', 'parkwest']);
    const cap = (id: string) => { const p = BALANCE_POOLS.find((x) => x.id === id)!; return p.caches * p.cacheGbps; };
    expect(cap('citywest')).toBeGreaterThan(cap('mam'));
    expect(cap('parkwest')).toBeGreaterThan(cap('dad'));
  });
});

describe('balanceForEqualUtilisation', () => {
  it('recommends weights ∝ capacity and projects EQUAL utilisation across pools', () => {
    const pools: BalancePool[] = [
      { id: 'citywest', capacity: 320, load: 300, currentWeight: 0.25 },
      { id: 'parkwest', capacity: 320, load: 160, currentWeight: 0.25 },
      { id: 'mam', capacity: 40, load: 30, currentWeight: 0.25 },
      { id: 'dad', capacity: 40, load: 20, currentWeight: 0.25 },
    ];
    const out = balanceForEqualUtilisation(pools);
    // total 510 / 720 = 70.8% target
    expect(out.totalCapacity).toBe(720);
    expect(out.totalLoad).toBe(510);
    expect(out.targetUtilisationPercent).toBeCloseTo(70.8, 1);
    // weights ∝ capacity: CW/PW 320/720 ≈ 44.4%, Mam/Dad 40/720 ≈ 5.6%
    const rec = (id: string) => out.pools.find((p) => p.id === id)!.recommendedShare;
    expect(rec('citywest')).toBeCloseTo(44.4, 1);
    expect(rec('mam')).toBeCloseTo(5.6, 1);
    // projected utilisation is EQUAL for all pools (the balance point)
    const proj = out.pools.map((p) => p.projectedUtilisationPercent);
    for (const u of proj) expect(u).toBeCloseTo(70.8, 1);
    // and it flags the current imbalance (CW 93.75% vs PW 50%)
    expect(out.currentSpreadPercent).toBeGreaterThan(40);
  });

  it('drops a pool weight when its capacity falls (a failed cache) — the dynamic part', () => {
    const healthy = balanceForEqualUtilisation([
      { id: 'mam', capacity: 40, load: 20 }, { id: 'citywest', capacity: 320, load: 200 },
    ]);
    const degraded = balanceForEqualUtilisation([
      { id: 'mam', capacity: 20, load: 20 }, { id: 'citywest', capacity: 320, load: 200 }, // one Mam cache down
    ]);
    const mamHealthy = healthy.pools.find((p) => p.id === 'mam')!.recommendedShare;
    const mamDegraded = degraded.pools.find((p) => p.id === 'mam')!.recommendedShare;
    expect(mamDegraded).toBeLessThan(mamHealthy); // less capacity ⇒ less weight ⇒ traffic shifts away
  });

  it('feedback gain trims weight away from an over-utilised pool', () => {
    const pools: BalancePool[] = [
      { id: 'citywest', capacity: 320, load: 300 }, // hot (93.75%)
      { id: 'parkwest', capacity: 320, load: 100 }, // cool (31%)
    ];
    const base = balanceForEqualUtilisation(pools).pools.find((p) => p.id === 'citywest')!.recommendedShare;
    const fed = balanceForEqualUtilisation(pools, { feedbackGain: 1 }).pools.find((p) => p.id === 'citywest')!.recommendedShare;
    expect(fed).toBeLessThan(base); // the hot pool is trimmed below its capacity-proportional share
  });

  it('handles unknown load (no telemetry) — capacity-proportional weights, null utilisation', () => {
    const out = balanceForEqualUtilisation([
      { id: 'citywest', capacity: 320, load: null }, { id: 'mam', capacity: 40 },
    ]);
    expect(out.totalLoad).toBeNull();
    expect(out.targetUtilisationPercent).toBeNull();
    expect(out.pools.find((p) => p.id === 'citywest')!.recommendedShare).toBeCloseTo(88.9, 1); // 320/360
    expect(out.pools.find((p) => p.id === 'citywest')!.utilisationPercent).toBeNull();
  });
});

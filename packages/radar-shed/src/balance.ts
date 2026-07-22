// DC load-balancer weight control — the complement to shed_load. shed_load spills an ISP to commercial
// CDNs when its PNIs saturate; THIS keeps traffic on the RTÉ CDN by balancing it across the delivery
// pools (Mam, Dad, Citywest, Parkwest) via Cloudflare Load Balancing POOL weights. Pure and standalone
// (no DB/HTTP/React) so the same solver runs in the dashboard (dry-run preview) and, later, a resilient
// balancer service that actually pushes weights to Cloudflare.
//
// Objective: EQUALISE UTILISATION across the pools. With traffic split in proportion to weight,
// util_i = load_i / cap_i, so equal utilisation ⟺ weight ∝ capacity. Because a pool's capacity is
// (healthy caches × per-cache throughput), a failed cache automatically lowers that pool's capacity →
// lowers its weight → shifts traffic away. That capacity-tracking is the "dynamic" in dynamic balancing;
// an optional load-feedback trim corrects residual imbalance the weight split alone doesn't explain.

export type PoolId = 'mam' | 'dad' | 'citywest' | 'parkwest';

export interface BalancePoolPolicy {
  id: PoolId;
  name: string;
  site: string;
  /** Substrings that identify this pool on a Cloudflare pool name (case-insensitive). */
  match: string[];
  /** Physical caches in the pool (used only so a failed cache proportionally lowers relative capacity). */
  caches: number;
  /** Per-cache RELATIVE capacity — only the RATIO between pools matters, never the absolute value.
   *  caches × this = the pool's relative capacity. */
  cacheGbps: number;
}

// Default pool policy. Only the RELATIVE capacity matters: Citywest/Parkwest ≈ 800 each, Mam/Dad ≈ 100
// each (an 8:1 ratio). Expressed as caches × per-cache so a failed cache drops the pool's capacity.
export const BALANCE_POOLS: readonly BalancePoolPolicy[] = [
  { id: 'citywest', name: 'Citywest', site: 'Citywest', match: ['citywest', 'cw'], caches: 4, cacheGbps: 200 }, // ≈ 800
  { id: 'parkwest', name: 'Parkwest', site: 'Parkwest', match: ['parkwest', 'pw'], caches: 4, cacheGbps: 200 }, // ≈ 800
  { id: 'mam', name: 'Mam', site: 'Donnybrook', match: ['mam'], caches: 2, cacheGbps: 50 }, // ≈ 100
  { id: 'dad', name: 'Dad', site: 'Donnybrook', match: ['dad'], caches: 2, cacheGbps: 50 }, // ≈ 100
];

export interface BalancePool {
  id: string;
  name?: string;
  /** Current healthy capacity (same unit as load — e.g. Gb/s). Failed caches reduce this. */
  capacity: number;
  /** Observed current load (same unit as capacity); null if unknown. */
  load?: number | null;
  /** Currently-configured Cloudflare pool weight (the predefined/static baseline); null if unknown. */
  currentWeight?: number | null;
}

export interface BalancedPool {
  id: string;
  name?: string;
  capacity: number;
  load: number | null;
  /** load / capacity × 100 (null when load unknown). */
  utilisationPercent: number | null;
  currentWeight: number | null;
  /** Recommended weight for equal utilisation, normalised so the set sums to 1. */
  recommendedWeight: number;
  /** recommendedWeight × 100. */
  recommendedShare: number;
  /** Utilisation each pool would tend to if the recommended weights were applied (equal across pools,
   *  absent feedback). Null when total load is unknown. */
  projectedUtilisationPercent: number | null;
}

export interface BalanceOutcome {
  pools: BalancedPool[];
  totalCapacity: number;
  totalLoad: number | null;
  /** totalLoad / totalCapacity × 100 — the utilisation all pools converge to when balanced. */
  targetUtilisationPercent: number | null;
  /** max − min current utilisation across pools with known load (0 = already balanced). */
  currentSpreadPercent: number | null;
}

export interface PairRebalance {
  /** New weights for the two pools — full precision (NOT rounded to %), sum preserved. Cloudflare pool
   *  weights are fine-grained floats, so we keep every digit to hit the balance precisely. */
  aWeight: number;
  bWeight: number;
  /** Relative imbalance: (b − a) / mean × 100. Positive ⇒ b is the hotter side. Null if either util unknown. */
  imbalancePercent: number | null;
}

/** Rebalance exactly TWO pools (e.g. Citywest ↔ Parkwest) from their live utilisation, WITHOUT touching
 *  any others. It's a FEEDBACK step: shift a portion of the combined weight from the busier DC to the
 *  quieter one, proportional to the imbalance — so when utilisation is already equal the weights are left
 *  unchanged, and over a live loop they converge. Weights stay full-precision (fine granularity, no %
 *  rounding). `gain` (default 1) scales the step; < 1 damps a fast loop. */
export function rebalancePair(
  a: { utilisationPercent: number | null; weight: number },
  b: { utilisationPercent: number | null; weight: number },
  opts: { gain?: number } = {},
): PairRebalance {
  const total = a.weight + b.weight;
  const ua = a.utilisationPercent;
  const ub = b.utilisationPercent;
  if (ua === null || ub === null || ua + ub <= 0 || total <= 0) {
    return { aWeight: a.weight, bWeight: b.weight, imbalancePercent: null };
  }
  const gain = opts.gain ?? 1;
  const rel = (ub - ua) / (ua + ub); // −1..1; positive ⇒ b hotter → shift weight to a
  const shift = gain * rel * total * 0.5; // 0 when balanced; half the combined weight at full imbalance
  const aWeight = Math.min(total, Math.max(0, a.weight + shift));
  const bWeight = total - aWeight;
  const imbalancePercent = Math.round(((ub - ua) / ((ua + ub) / 2)) * 1000) / 10;
  return { aWeight, bWeight, imbalancePercent };
}

/** Compute the weights that equalise utilisation across the pools. `feedbackGain` (default 0) trims the
 *  capacity-proportional weights toward pools running below the target and away from those above it —
 *  use a small value (~0.5–1) so the dynamic loop corrects imbalance the weight split alone can't. */
export function balanceForEqualUtilisation(pools: BalancePool[], opts: { feedbackGain?: number } = {}): BalanceOutcome {
  const gain = opts.feedbackGain ?? 0;
  const totalCapacity = pools.reduce((s, p) => s + Math.max(0, p.capacity), 0);
  const known = pools.filter((p) => typeof p.load === 'number') as (BalancePool & { load: number })[];
  const totalLoad = known.length ? known.reduce((s, p) => s + p.load, 0) : null;
  const targetUtil = totalLoad !== null && totalCapacity > 0 ? (totalLoad / totalCapacity) * 100 : null;

  // Base weight ∝ capacity, optionally trimmed by how far each pool is from the target utilisation.
  const raw = pools.map((p) => {
    const base = totalCapacity > 0 ? Math.max(0, p.capacity) / totalCapacity : 1 / pools.length;
    const util = typeof p.load === 'number' && p.capacity > 0 ? (p.load / p.capacity) * 100 : null;
    let w = base;
    if (gain > 0 && util !== null && targetUtil && targetUtil > 0) {
      w = Math.max(0, base * (1 + gain * ((targetUtil - util) / targetUtil)));
    }
    return { p, util, w };
  });
  const wSum = raw.reduce((s, r) => s + r.w, 0) || 1;

  const outPools: BalancedPool[] = raw.map(({ p, util, w }) => {
    const recommendedWeight = w / wSum;
    const projected = totalLoad !== null && p.capacity > 0 ? ((totalLoad * recommendedWeight) / p.capacity) * 100 : null;
    return {
      id: p.id,
      name: p.name,
      capacity: p.capacity,
      load: typeof p.load === 'number' ? p.load : null,
      utilisationPercent: util === null ? null : Math.round(util * 10) / 10,
      currentWeight: typeof p.currentWeight === 'number' ? p.currentWeight : null,
      recommendedWeight,
      recommendedShare: Math.round(recommendedWeight * 1000) / 10,
      projectedUtilisationPercent: projected === null ? null : Math.round(projected * 10) / 10,
    };
  });

  const utils = outPools.map((p) => p.utilisationPercent).filter((u): u is number => u !== null);
  const currentSpread = utils.length ? Math.round((Math.max(...utils) - Math.min(...utils)) * 10) / 10 : null;

  return {
    pools: outPools,
    totalCapacity,
    totalLoad,
    targetUtilisationPercent: targetUtil === null ? null : Math.round(targetUtil * 10) / 10,
    currentSpreadPercent: currentSpread,
  };
}

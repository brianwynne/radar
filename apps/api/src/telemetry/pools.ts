// The ONE central, RADAR-owned Réalta cache-pool / cache-node / origin configuration.
// Capacities and node counts are MANUALLY MAINTAINED architecture values (never observed):
//   Donnybrook — 4 caches total, ~80 Gb/s practical (CPU-bound) each, ~320 Gb/s aggregate.
//   External Pool 1 — 4 caches, ~700 Gb/s outbound.
//   External Pool 2 — 4 caches, ~700 Gb/s outbound.
// Kept in step with apps/web/src/topology/model.ts. Donnybrook is modelled as two pools of
// two caches (2 × 160 Gb/s = 320 Gb/s) to match the topology's Donnybrook Pool 1/2.
import type { CacheNodeMapping, CachePoolMapping, OriginMapping } from './cache-types.js';

const Gbps = 1_000_000_000;

export const DEFAULT_TARGET_PERCENT = 70;
export const DEFAULT_WARNING_PERCENT = 80;
export const DEFAULT_CRITICAL_PERCENT = 90;

const T = { targetPercent: DEFAULT_TARGET_PERCENT, warningPercent: DEFAULT_WARNING_PERCENT, criticalPercent: DEFAULT_CRITICAL_PERCENT };

export const CACHE_POOL_MAPPINGS: CachePoolMapping[] = [
  { id: 'donnybrook-1', name: 'Donnybrook Pool 1', site: 'Donnybrook', cacheNodeCount: 2, configuredCapacityBps: 160 * Gbps, ...T },
  { id: 'donnybrook-2', name: 'Donnybrook Pool 2', site: 'Donnybrook', cacheNodeCount: 2, configuredCapacityBps: 160 * Gbps, ...T },
  { id: 'external-1', name: 'External Pool 1', site: 'External', cacheNodeCount: 4, configuredCapacityBps: 700 * Gbps, ...T },
  { id: 'external-2', name: 'External Pool 2', site: 'External', cacheNodeCount: 4, configuredCapacityBps: 700 * Gbps, ...T },
];

/** Cache nodes derived from the pools (per-node capacity = pool capacity / node count). */
export const CACHE_NODE_MAPPINGS: CacheNodeMapping[] = CACHE_POOL_MAPPINGS.flatMap((pool) =>
  Array.from({ length: pool.cacheNodeCount }, (_unused, i) => ({
    id: `${pool.id}-n${i + 1}`,
    name: `${pool.name} — node ${i + 1}`,
    poolId: pool.id,
    site: pool.site,
    configuredCapacityBps: Math.round(pool.configuredCapacityBps / pool.cacheNodeCount),
    ...T,
  })),
);

export const ORIGIN_MAPPING: OriginMapping = { id: 'origin', name: 'Réalta origin', ...T };

export interface ThresholdOverrides {
  warningPercent?: number;
  criticalPercent?: number;
}

const applyThresholds = <M extends { warningPercent: number; criticalPercent: number }>(m: M, o: ThresholdOverrides): M => ({
  ...m,
  warningPercent: o.warningPercent ?? m.warningPercent,
  criticalPercent: o.criticalPercent ?? m.criticalPercent,
});

export function resolvePoolMappings(o: ThresholdOverrides = {}): CachePoolMapping[] {
  return CACHE_POOL_MAPPINGS.map((m) => applyThresholds(m, o));
}
export function resolveNodeMappings(o: ThresholdOverrides = {}): CacheNodeMapping[] {
  return CACHE_NODE_MAPPINGS.map((m) => applyThresholds(m, o));
}
export function resolveOriginMapping(o: ThresholdOverrides = {}): OriginMapping {
  return applyThresholds(ORIGIN_MAPPING, o);
}

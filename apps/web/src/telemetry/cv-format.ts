// Presentation helpers for CloudVision network telemetry. Formatting/mapping only — never
// invents a value. Reuses the shared badge vocabulary (ok/warn/danger/neutral/info) so the
// Network Telemetry page reads as one system with the rest of RADAR.
import type { BandwidthSource, BgpState, FreshnessLevel, NetworkHealth, OperState } from '../api/types';

export type Badge = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';
export interface Meta {
  label: string;
  badge: Badge;
}

const HEALTH: Record<NetworkHealth, Meta> = {
  healthy: { label: 'healthy', badge: 'ok' },
  warning: { label: 'warning', badge: 'warn' },
  critical: { label: 'critical', badge: 'danger' },
  down: { label: 'down', badge: 'danger' },
  unavailable: { label: 'unavailable', badge: 'neutral' },
  unknown: { label: 'unknown', badge: 'neutral' },
};
export const healthMeta = (s: NetworkHealth): Meta => HEALTH[s] ?? { label: s, badge: 'neutral' };

const FRESHNESS: Record<FreshnessLevel, Meta> = {
  FRESH: { label: 'fresh', badge: 'ok' },
  DEGRADED: { label: 'degraded', badge: 'warn' },
  STALE: { label: 'stale', badge: 'warn' },
  UNAVAILABLE: { label: 'unavailable', badge: 'neutral' },
};
export const freshnessMeta = (l: FreshnessLevel): Meta => FRESHNESS[l] ?? { label: l, badge: 'neutral' };

export function bgpMeta(state: BgpState): Meta {
  if (state === 'ESTABLISHED') return { label: 'established', badge: 'ok' };
  if (state === 'IDLE') return { label: 'idle', badge: 'danger' };
  if (state === 'UNKNOWN') return { label: 'unknown', badge: 'neutral' };
  return { label: state.toLowerCase(), badge: 'warn' };
}

export const operMeta = (s: OperState): Meta =>
  s === 'up' ? { label: 'up', badge: 'ok' } : s === 'down' ? { label: 'down', badge: 'danger' } : { label: 'unknown', badge: 'neutral' };

/** Bandwidth-source tag — REPORTED (direct), DERIVED (from counters), UNAVAILABLE. */
export const bandwidthSourceMeta = (s: BandwidthSource): Meta =>
  s === 'REPORTED' ? { label: 'reported', badge: 'info' } : s === 'DERIVED' ? { label: 'derived', badge: 'neutral' } : { label: 'no data', badge: 'neutral' };

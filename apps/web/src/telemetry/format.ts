// Presentation helpers for read-only network-path telemetry. Formatting only — never
// invents a value; a missing observation renders as an explicit placeholder.
import type { TelemetryStatus } from '../api/types';

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(bps >= 1e10 ? 0 : 1)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(0)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kb/s`;
  return `${bps} b/s`;
}

export function formatPercent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

export function formatFreshness(ageSeconds: number | null | undefined): string {
  if (ageSeconds === null || ageSeconds === undefined) return 'no observation';
  if (ageSeconds < 1) return 'just now';
  if (ageSeconds < 90) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 5400) return `${Math.round(ageSeconds / 60)}m ago`;
  return `${Math.round(ageSeconds / 3600)}h ago`;
}

export interface StatusMeta {
  label: string;
  badge: 'ok' | 'warn' | 'danger' | 'neutral' | 'info';
}

const STATUS_META: Record<TelemetryStatus, StatusMeta> = {
  healthy: { label: 'healthy', badge: 'ok' },
  above_target: { label: 'above target', badge: 'warn' },
  warning: { label: 'warning', badge: 'warn' },
  critical: { label: 'critical', badge: 'danger' },
  stale: { label: 'stale', badge: 'warn' },
  unavailable: { label: 'unavailable', badge: 'neutral' },
  telemetry_not_connected: { label: 'telemetry not connected', badge: 'neutral' },
};

export const statusMeta = (status: TelemetryStatus): StatusMeta => STATUS_META[status] ?? { label: status, badge: 'neutral' };

/** True when a sample carries a real, fresh observed value worth rendering as a number. */
export const hasFreshValue = (status: TelemetryStatus): boolean =>
  status === 'healthy' || status === 'above_target' || status === 'warning' || status === 'critical';

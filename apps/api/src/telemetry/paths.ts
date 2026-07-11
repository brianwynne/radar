// The ONE central, RADAR-owned path → interface/capacity mapping. Every telemetry backend
// reads paths from here; nothing else defines a path. Capacities/targets are CONFIGURED
// (manually maintained), never observed. Kept in step with apps/web/src/topology/model.ts
// and apps/api/src/change-detection/isps.ts (preferred-path labels must match exactly).
import type { PathMapping } from './types.js';

const Gbps = 1_000_000_000;

/** Default warning/critical thresholds (percent). Overridable per env in config.ts. */
export const DEFAULT_TARGET_PERCENT = 70;
export const DEFAULT_WARNING_PERCENT = 80;
export const DEFAULT_CRITICAL_PERCENT = 90;

/** Base configured mapping. `interfaceIdentity` is the logical link identity used to build
 *  the source query (server-side only; never from browser input). Thresholds here are the
 *  defaults; config.ts may override warning/critical globally. */
export const NETWORK_PATH_MAPPINGS: PathMapping[] = [
  { id: 'eir-pni', name: 'Eir PNI', type: 'PNI', interfaceIdentity: 'pni-eir', configuredCapacityBps: 100 * Gbps, configuredTargetPercent: DEFAULT_TARGET_PERCENT, warningThresholdPercent: DEFAULT_WARNING_PERCENT, criticalThresholdPercent: DEFAULT_CRITICAL_PERCENT, direction: 'outbound' },
  { id: 'virgin-liberty-pni', name: 'Virgin / Liberty PNI', type: 'PNI', interfaceIdentity: 'pni-virgin', configuredCapacityBps: 100 * Gbps, configuredTargetPercent: DEFAULT_TARGET_PERCENT, warningThresholdPercent: DEFAULT_WARNING_PERCENT, criticalThresholdPercent: DEFAULT_CRITICAL_PERCENT, direction: 'outbound' },
  { id: 'inex', name: 'INEX', type: 'INEX', interfaceIdentity: 'ixp-inex', configuredCapacityBps: 40 * Gbps, configuredTargetPercent: DEFAULT_TARGET_PERCENT, warningThresholdPercent: DEFAULT_WARNING_PERCENT, criticalThresholdPercent: DEFAULT_CRITICAL_PERCENT, direction: 'outbound' },
  { id: 'transit', name: 'Transit', type: 'transit', interfaceIdentity: 'transit-primary', configuredCapacityBps: 20 * Gbps, configuredTargetPercent: DEFAULT_TARGET_PERCENT, warningThresholdPercent: DEFAULT_WARNING_PERCENT, criticalThresholdPercent: DEFAULT_CRITICAL_PERCENT, direction: 'outbound' },
];

/** Apply global threshold overrides (from config) to the base mappings. */
export function resolveMappings(overrides: { warningPercent?: number; criticalPercent?: number } = {}): PathMapping[] {
  return NETWORK_PATH_MAPPINGS.map((m) => ({
    ...m,
    warningThresholdPercent: overrides.warningPercent ?? m.warningThresholdPercent,
    criticalThresholdPercent: overrides.criticalPercent ?? m.criticalThresholdPercent,
  }));
}

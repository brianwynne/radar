// Pure, source-independent classification: turn a raw PathObservation into a fully-graded
// NetworkPathSample. This is where CONFIGURED capacity/target meets OBSERVED rates, where
// utilisation is computed, and where health/stale/freshness are decided — honestly (an
// absent or stale value never becomes an invented number).
import type {
  NetworkPathSample, PathMapping, PathObservation, SampleProvenance, TelemetryDirection,
  TelemetryFreshness, TelemetrySource, TelemetryStatus,
} from './types.js';

/** Utilisation percent of a rate against configured capacity. Returns null for a missing
 *  rate or a non-positive/invalid capacity (never divides by zero or invents a value). */
export function utilisationPercent(rateBps: number | null, capacityBps: number): number | null {
  if (rateBps === null || !Number.isFinite(rateBps) || rateBps < 0) return null;
  if (!Number.isFinite(capacityBps) || capacityBps <= 0) return null;
  return (rateBps / capacityBps) * 100;
}

/** Classify utilisation against configured thresholds. Assumes a fresh, valid utilisation. */
export function classifyUtilisation(util: number, m: Pick<PathMapping, 'configuredTargetPercent' | 'warningThresholdPercent' | 'criticalThresholdPercent'>): TelemetryStatus {
  if (util >= m.criticalThresholdPercent) return 'critical';
  if (util >= m.warningThresholdPercent) return 'warning';
  if (util > m.configuredTargetPercent) return 'above_target';
  return 'healthy';
}

interface BuildContext {
  now: number; // epoch ms
  staleAfterSeconds: number;
  source: TelemetrySource;
  synthetic: boolean;
}

const provenanceFor = (source: TelemetrySource, synthetic: boolean): SampleProvenance => ({
  source,
  synthetic,
  readOnly: true,
  informationalOnly: true,
  note:
    source === 'disabled'
      ? 'Network telemetry is disabled; utilisation is not connected.'
      : synthetic
        ? 'MOCK / SYNTHETIC — not production telemetry.'
        : 'Observed network telemetry (informational only; RADAR does not modify NS1 steering).',
});

/** Assemble a classified sample from a mapping + observation. `observation === null` means
 *  the source produced nothing for this path (→ unavailable, or telemetry_not_connected when
 *  disabled). */
export function buildSample(mapping: PathMapping, observation: PathObservation | null, ctx: BuildContext): NetworkPathSample {
  const direction: TelemetryDirection = mapping.direction;
  const warnings = [...(observation?.warnings ?? [])];

  const base = {
    pathId: mapping.id,
    pathName: mapping.name,
    pathType: mapping.type,
    interfaceIdentity: mapping.interfaceIdentity,
    configuredCapacityBps: mapping.configuredCapacityBps,
    configuredTargetPercent: mapping.configuredTargetPercent,
    warningThresholdPercent: mapping.warningThresholdPercent,
    criticalThresholdPercent: mapping.criticalThresholdPercent,
    direction,
    source: ctx.source,
    provenance: provenanceFor(ctx.source, ctx.synthetic),
  };

  const disconnected = (status: TelemetryStatus): NetworkPathSample => ({
    ...base,
    observedInboundBps: null,
    observedOutboundBps: null,
    observedUtilisationPercent: null,
    observedAt: null,
    status,
    stale: false,
    freshness: { ageSeconds: null, staleAfterSeconds: ctx.staleAfterSeconds, fresh: false },
    warnings,
  });

  if (ctx.source === 'disabled') return disconnected('telemetry_not_connected');
  if (observation === null) return disconnected('unavailable');

  const primaryRate = direction === 'inbound' ? observation.inboundBps : observation.outboundBps;
  const util = utilisationPercent(primaryRate, mapping.configuredCapacityBps);

  // No usable observed rate or capacity → unavailable (never invent a value).
  if (util === null || observation.observedAt === null) {
    if (observation.observedAt === null) warnings.push('No observation timestamp from source.');
    if (util === null) warnings.push('No usable observed rate for the primary direction.');
    return disconnected('unavailable');
  }

  const ageSeconds = Math.max(0, (ctx.now - observation.observedAt.getTime()) / 1000);
  const stale = ageSeconds > ctx.staleAfterSeconds;
  const freshness: TelemetryFreshness = { ageSeconds, staleAfterSeconds: ctx.staleAfterSeconds, fresh: !stale };
  const status = stale ? 'stale' : classifyUtilisation(util, mapping);

  return {
    ...base,
    observedInboundBps: observation.inboundBps,
    observedOutboundBps: observation.outboundBps,
    observedUtilisationPercent: util,
    observedAt: observation.observedAt.toISOString(),
    status,
    stale,
    freshness,
    warnings,
  };
}

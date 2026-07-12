// Pure classification for cache-pool / cache-node / origin telemetry. Reuses the shared
// utilisation/threshold/freshness helpers. CONFIGURED capacity meets OBSERVED throughput/CPU
// here; headroom is computed deterministically (capacity − observed throughput) and is null
// when either is unavailable. Never invents a value.
import { classifyUtilisation, freshnessOf, utilisationPercent, worstStatus } from './sample.js';
import type {
  CacheNodeMapping, CacheNodeSample, CacheObservation, CachePoolMapping, CachePoolSample,
  OriginMapping, OriginObservation, OriginSample,
} from './cache-types.js';
import type { SampleProvenance, TelemetrySource, TelemetryStatus } from './types.js';

interface Ctx {
  now: number;
  staleAfterSeconds: number;
  source: TelemetrySource;
  synthetic: boolean;
}

function provenanceFor(source: TelemetrySource, synthetic: boolean): SampleProvenance {
  return {
    source,
    synthetic,
    readOnly: true,
    informationalOnly: true,
    note:
      source === 'disabled'
        ? 'Cache/origin telemetry is disabled; utilisation is not connected.'
        : synthetic
          ? 'MOCK / SYNTHETIC — not production telemetry.'
          : 'Observed cache/origin telemetry (informational only; RADAR does not modify NS1 or Cloudflare).',
  };
}

/** A cache hit ratio is only meaningful in [0, 1]; anything else is dropped with a warning. */
function validHitRatio(ratio: number | null, warnings: string[]): number | null {
  if (ratio === null) return null;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    warnings.push('Cache hit ratio out of range [0,1]; dropped.');
    return null;
  }
  return ratio;
}

/** Deterministic headroom: configured capacity − observed throughput. Null when either is
 *  unavailable (never a negative-capacity artefact or an invented value). */
export function headroom(configuredCapacityBps: number, observedOutboundBps: number | null): number | null {
  if (observedOutboundBps === null || !Number.isFinite(observedOutboundBps)) return null;
  if (!Number.isFinite(configuredCapacityBps) || configuredCapacityBps <= 0) return null;
  return configuredCapacityBps - observedOutboundBps;
}

type Thresholds = { targetPercent: number; warningPercent: number; criticalPercent: number };
const thresholdsFor = (m: Thresholds) => ({ configuredTargetPercent: m.targetPercent, warningThresholdPercent: m.warningPercent, criticalThresholdPercent: m.criticalPercent });

/** Overall health = worst of throughput-utilisation and CPU-utilisation classifications
 *  (whichever signals are available). Undefined when neither is available. */
function healthFrom(throughputUtil: number | null, cpu: number | null, m: Thresholds): TelemetryStatus | undefined {
  const parts: TelemetryStatus[] = [];
  if (throughputUtil !== null) parts.push(classifyUtilisation(throughputUtil, thresholdsFor(m)));
  if (cpu !== null) parts.push(classifyUtilisation(cpu, thresholdsFor(m)));
  return parts.length > 0 ? worstStatus(...parts) : undefined;
}

function buildCache(
  base: { configuredCapacityBps: number } & Thresholds,
  observation: CacheObservation | null,
  ctx: Ctx,
): {
  observedOutboundBps: number | null; observedUtilisationPercent: number | null; cpuUtilisationPercent: number | null;
  memoryUtilisationPercent: number | null; cacheHitRatio: number | null; requestRate: number | null; observedAt: string | null;
  headroomBps: number | null; status: TelemetryStatus; stale: boolean; freshness: ReturnType<typeof freshnessOf>;
  source: TelemetrySource; warnings: string[]; provenance: SampleProvenance;
} {
  const provenance = provenanceFor(ctx.source, ctx.synthetic);
  const empty = (status: TelemetryStatus, warnings: string[] = []) => ({
    observedOutboundBps: null, observedUtilisationPercent: null, cpuUtilisationPercent: null, memoryUtilisationPercent: null,
    cacheHitRatio: null, requestRate: null, observedAt: null, headroomBps: null, status, stale: false,
    freshness: freshnessOf(null, ctx.now, ctx.staleAfterSeconds), source: ctx.source, warnings, provenance,
  });

  if (ctx.source === 'disabled') return empty('telemetry_not_connected');
  if (observation === null) return empty('unavailable');

  const warnings = [...(observation.warnings ?? [])];
  const util = utilisationPercent(observation.outboundBps, base.configuredCapacityBps);
  const hitRatio = validHitRatio(observation.cacheHitRatio, warnings);

  // Nothing usable at all → unavailable (never invent a value).
  if (observation.observedAt === null || (util === null && observation.cpuUtilisationPercent === null)) {
    if (observation.observedAt === null) warnings.push('No observation timestamp from source.');
    return empty('unavailable', warnings);
  }

  const freshness = freshnessOf(observation.observedAt, ctx.now, ctx.staleAfterSeconds);
  const stale = !freshness.fresh;
  const health = healthFrom(util, observation.cpuUtilisationPercent, base);
  const status: TelemetryStatus = stale ? 'stale' : health ?? 'unavailable';

  return {
    observedOutboundBps: observation.outboundBps,
    observedUtilisationPercent: util,
    cpuUtilisationPercent: observation.cpuUtilisationPercent,
    memoryUtilisationPercent: observation.memoryUtilisationPercent,
    cacheHitRatio: hitRatio,
    requestRate: observation.requestRate,
    observedAt: observation.observedAt.toISOString(),
    headroomBps: headroom(base.configuredCapacityBps, observation.outboundBps),
    status,
    stale,
    freshness,
    source: ctx.source,
    warnings,
    provenance,
  };
}

export function buildPoolSample(mapping: CachePoolMapping, observation: CacheObservation | null, ctx: Ctx): CachePoolSample {
  const c = buildCache(mapping, observation, ctx);
  return {
    poolId: mapping.id, poolName: mapping.name, site: mapping.site, cacheNodeCount: mapping.cacheNodeCount,
    configuredCapacityBps: mapping.configuredCapacityBps, targetPercent: mapping.targetPercent,
    warningPercent: mapping.warningPercent, criticalPercent: mapping.criticalPercent, ...c,
  };
}

export function buildNodeSample(mapping: CacheNodeMapping, observation: CacheObservation | null, ctx: Ctx): CacheNodeSample {
  const c = buildCache(mapping, observation, ctx);
  return {
    nodeId: mapping.id, nodeName: mapping.name, poolId: mapping.poolId, site: mapping.site,
    configuredCapacityBps: mapping.configuredCapacityBps, targetPercent: mapping.targetPercent,
    warningPercent: mapping.warningPercent, criticalPercent: mapping.criticalPercent, ...c,
  };
}

export function buildOriginSample(mapping: OriginMapping, observation: OriginObservation | null, ctx: Ctx): OriginSample {
  const provenance = provenanceFor(ctx.source, ctx.synthetic);
  const empty = (status: TelemetryStatus, warnings: string[] = []): OriginSample => ({
    originId: mapping.id, originName: mapping.name, requestRate: null, outboundBandwidthBps: null, cpuUtilisationPercent: null,
    observedAt: null, status, stale: false, freshness: freshnessOf(null, ctx.now, ctx.staleAfterSeconds), source: ctx.source, warnings, provenance,
  });

  if (ctx.source === 'disabled') return empty('telemetry_not_connected');
  if (observation === null) return empty('unavailable');

  const warnings = [...(observation.warnings ?? [])];
  if (observation.observedAt === null || observation.cpuUtilisationPercent === null) {
    if (observation.observedAt === null) warnings.push('No observation timestamp from source.');
    if (observation.cpuUtilisationPercent === null) warnings.push('No CPU utilisation from source.');
    return empty('unavailable', warnings);
  }

  const freshness = freshnessOf(observation.observedAt, ctx.now, ctx.staleAfterSeconds);
  const stale = !freshness.fresh;
  const status: TelemetryStatus = stale ? 'stale' : classifyUtilisation(observation.cpuUtilisationPercent, thresholdsFor(mapping));

  return {
    originId: mapping.id, originName: mapping.name, requestRate: observation.requestRate, outboundBandwidthBps: observation.outboundBandwidthBps,
    cpuUtilisationPercent: observation.cpuUtilisationPercent, observedAt: observation.observedAt.toISOString(),
    status, stale, freshness, source: ctx.source, warnings, provenance,
  };
}

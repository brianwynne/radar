// bgp.tools ADAPTER — pure, deterministic normalisation + routing-integrity assessment. All
// business logic lives here; the client only fetches. Given the same inputs and `now`, the output
// is identical (injectable clock, no I/O). Raw observations, normalised signals and the verdict
// are kept separate so an operator can trace every conclusion back to documented evidence. Nothing
// is invented: an absent origin is "withdrawn", stale data is "unknown" — never a healthy guess.
import type {
  BgpToolsProvenance, BgpToolsSource, MonitoredPrefix, NormalizedRoutingSignal, RawRoutingObservation,
  RoutingIntegrityAssessment, RoutingIntegrityCounts, RoutingIntegrityState, RoutingIntelligenceSnapshot,
  SourceConfidence,
} from './types.js';

/** Tunable thresholds for the assessment. Ratios are 0..1 of the full-visibility baseline. */
export interface AssessmentThresholds {
  /** Below this visibility ratio → degraded. */
  visibilityWarnRatio: number;
  /** Below this visibility ratio → critical. */
  visibilityCriticalRatio: number;
  /** An observation older than this (seconds) is stale → unknown. */
  maxAgeSeconds: number;
}

export interface BuildOptions {
  /** Epoch ms; injected for determinism. */
  now: number;
  /** Visibility hits that represent full/global visibility (the table's collector-session count). */
  fullVisibilityHits: number;
  thresholds: AssessmentThresholds;
  source: BgpToolsSource;
  synthetic: boolean;
  /** Optional prior first-seen timestamps (epoch ms) per prefix, so first_observed_at persists
   *  across polls when the caller supplies history. Absent → firstObservedAt = the observation. */
  firstSeen?: Map<string, number>;
}

export const DEFAULT_THRESHOLDS: AssessmentThresholds = {
  visibilityWarnRatio: 0.85,
  visibilityCriticalRatio: 0.5,
  maxAgeSeconds: 2 * 60 * 60, // bgp.tools table caches ~2h; older than that is stale
};

const STATE_SEVERITY: Record<RoutingIntegrityState, number> = { healthy: 0, unknown: 1, degraded: 2, critical: 3 };
const worse = (a: RoutingIntegrityState, b: RoutingIntegrityState): RoutingIntegrityState =>
  STATE_SEVERITY[a] >= STATE_SEVERITY[b] ? a : b;

function confidenceOf(ratio: number | null, stale: boolean): SourceConfidence {
  if (stale || ratio === null) return 'low';
  if (ratio >= 0.8) return 'high';
  if (ratio >= 0.3) return 'medium';
  return 'low';
}

/** Normalise one monitored prefix against its raw observation (undefined ⇒ not in the table ⇒
 *  withdrawn). Pure; no verdict here — only the derived signals. */
export function normalizePrefix(
  monitored: MonitoredPrefix,
  raw: RawRoutingObservation | undefined,
  opts: BuildOptions,
): NormalizedRoutingSignal {
  const origins = [...(raw?.origins ?? [])].sort((a, b) => b.hits - a.hits);
  const observedAt = raw?.observedAt ?? new Date(opts.now);
  const withdrawn = origins.length === 0;
  const distinctAsns = new Set(origins.map((o) => o.asn));
  const expectedPresent = distinctAsns.has(monitored.expectedOriginAsn);
  const observationCount = origins.reduce((s, o) => s + o.hits, 0);
  const ratio = withdrawn ? null : Math.min(1, observationCount / Math.max(1, opts.fullVisibilityHits));
  const ageSeconds = Math.max(0, (opts.now - observedAt.getTime()) / 1000);
  const stale = ageSeconds > opts.thresholds.maxAgeSeconds;
  const firstMs = opts.firstSeen?.get(monitored.prefix) ?? observedAt.getTime();

  return {
    prefix: monitored.prefix,
    addressFamily: monitored.addressFamily,
    expectedOriginAsn: monitored.expectedOriginAsn,
    observedOriginAsn: origins[0]?.asn ?? null,
    observedOrigins: origins,
    // "As expected" means the expected ASN is the SOLE origin — any foreign origin is a concern.
    originAsExpected: expectedPresent && distinctAsns.size === 1,
    prefixWithdrawn: withdrawn,
    unexpectedOrigin: origins.some((o) => o.asn !== monitored.expectedOriginAsn),
    moas: distinctAsns.size > 1,
    prefixVisibilityRatio: ratio,
    observationCount,
    firstObservedAt: new Date(Math.min(firstMs, observedAt.getTime())),
    lastObservedAt: observedAt,
    sourceConfidence: confidenceOf(ratio, stale),
    stale,
  };
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

/** RADAR's verdict for one prefix, from its normalised signals. Deterministic; every reason maps
 *  to a signal field. Order of precedence: stale→unknown, withdrawn→critical, expected-origin-
 *  absent→critical, then visibility + MOAS downgrades. */
export function assessPrefix(signal: NormalizedRoutingSignal, thresholds: AssessmentThresholds, now: number): RoutingIntegrityAssessment {
  const assessedAt = new Date(now);
  const base = { prefix: signal.prefix, signals: signal, assessedAt };

  if (signal.stale) {
    return { ...base, state: 'unknown', reasons: ['Observation is stale (older than the freshness window) — integrity cannot be assessed.'] };
  }
  if (signal.prefixWithdrawn) {
    return { ...base, state: 'critical', reasons: [`Prefix is withdrawn — no origin ASN observed (expected AS${signal.expectedOriginAsn}).`] };
  }
  // Expected origin absent but some other ASN announces it → possible hijack / takeover.
  if (!signal.observedOrigins.some((o) => o.asn === signal.expectedOriginAsn)) {
    const others = signal.observedOrigins.map((o) => `AS${o.asn}`).join(', ');
    return { ...base, state: 'critical', reasons: [`Expected origin AS${signal.expectedOriginAsn} is absent; prefix is originated by ${others} — possible hijack or takeover.`] };
  }

  // Expected origin is present. Layer on visibility + MOAS concerns.
  let state: RoutingIntegrityState = 'healthy';
  const reasons: string[] = [];
  const ratio = signal.prefixVisibilityRatio;

  if (ratio !== null && ratio < thresholds.visibilityCriticalRatio) {
    state = worse(state, 'critical');
    reasons.push(`Visibility ${pct(ratio)} is below the critical threshold ${pct(thresholds.visibilityCriticalRatio)} — the prefix is widely unseen.`);
  } else if (ratio !== null && ratio < thresholds.visibilityWarnRatio) {
    state = worse(state, 'degraded');
    reasons.push(`Visibility ${pct(ratio)} is below the warning threshold ${pct(thresholds.visibilityWarnRatio)} — partial visibility loss.`);
  }
  if (signal.moas) {
    state = worse(state, 'degraded');
    const foreign = signal.observedOrigins.filter((o) => o.asn !== signal.expectedOriginAsn).map((o) => `AS${o.asn}`).join(', ');
    reasons.push(`Expected AS${signal.expectedOriginAsn} is present, but ${foreign} also announces this prefix (MOAS) — possible partial hijack or leak.`);
  }
  if (state === 'healthy') reasons.push(`Originated solely by the expected AS${signal.expectedOriginAsn} at ${ratio !== null ? pct(ratio) : 'full'} visibility.`);
  return { ...base, state, reasons };
}

function rollUp(assessments: RoutingIntegrityAssessment[]): { overall: RoutingIntegrityState; counts: RoutingIntegrityCounts } {
  const counts: RoutingIntegrityCounts = { healthy: 0, degraded: 0, critical: 0, unknown: 0, total: assessments.length };
  let overall: RoutingIntegrityState = 'healthy';
  for (const a of assessments) {
    counts[a.state] += 1;
    overall = worse(overall, a.state);
  }
  if (assessments.length === 0) overall = 'unknown';
  return { overall, counts };
}

function provenanceFor(source: BgpToolsSource, synthetic: boolean): BgpToolsProvenance {
  return {
    source,
    synthetic,
    readOnly: true,
    note:
      source === 'disabled'
        ? 'bgp.tools routing intelligence is disabled; external routing state is not connected.'
        : synthetic
          ? 'MOCK / SYNTHETIC — not live bgp.tools data.'
          : 'Observed bgp.tools routing data (read-only; RADAR never modifies BGP or NS1).',
  };
}

/** Build the full routing-intelligence snapshot: normalise every monitored prefix against its raw
 *  observation, assess each, and roll up the overall state + counts. Pure and deterministic. */
export function buildSnapshot(
  monitored: MonitoredPrefix[],
  raws: RawRoutingObservation[],
  opts: BuildOptions,
): RoutingIntelligenceSnapshot {
  const rawByPrefix = new Map(raws.map((r) => [r.prefix, r]));
  const warnings: string[] = [];
  const assessments = monitored.map((m) => {
    const signal = normalizePrefix(m, rawByPrefix.get(m.prefix), opts);
    if (signal.stale) warnings.push(`${m.prefix}: observation is stale.`);
    return assessPrefix(signal, opts.thresholds, opts.now);
  });
  const { overall, counts } = rollUp(assessments);
  if (monitored.length === 0) warnings.push('No prefixes are configured for monitoring.');
  return {
    capturedAt: new Date(opts.now).toISOString(),
    source: opts.source,
    overall,
    counts,
    assessments,
    provenance: provenanceFor(opts.source, opts.synthetic),
    warnings,
  };
}

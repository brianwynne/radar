// bgp.tools connector — canonical domain model. READ-ONLY external routing intelligence: RADAR
// observes bgp.tools' publicly-documented data (the table dump: every prefix each AS originates,
// with a visibility hit count) and NEVER modifies BGP or NS1. The model deliberately keeps three
// layers separate so an operator can see exactly how a conclusion was reached:
//   1. RawRoutingObservation  — what the provider reported (table row(s) for a prefix)
//   2. NormalizedRoutingSignal — RADAR's normalised signals derived from raw + expected config
//   3. RoutingIntegrityAssessment — RADAR's healthy/degraded/critical/unknown verdict + reasons
// Only signals with a DOCUMENTED bgp.tools source are modelled here (prefix visibility, origin,
// withdrawal, observation counts). RPKI / upstreams / AS-path / leaks have no documented export
// and are intentionally out of scope for v1 (never fabricated).

export type AddressFamily = 'ipv4' | 'ipv6';

export type RoutingIntegrityState = 'healthy' | 'degraded' | 'critical' | 'unknown';

/** Confidence in an observation, from how widely the prefix is seen and how fresh the data is. */
export type SourceConfidence = 'high' | 'medium' | 'low';

/** Where a datum came from — the provider's live table, or synthetic mock/fixture data. */
export type BgpToolsSource = 'bgptools' | 'mock' | 'disabled';

/** One prefix that RADAR watches, with the origin ASN it is EXPECTED to be announced from. */
export interface MonitoredPrefix {
  prefix: string;
  addressFamily: AddressFamily;
  /** The ASN RADAR expects to originate this prefix (RTÉ's own or a contracted origin). */
  expectedOriginAsn: number;
  /** Optional operator label (site / service) — never affects the assessment. */
  description?: string;
}

/** A single origin seen for a prefix in the provider's table, with its visibility hit count
 *  (how many of the provider's collector sessions observed it). */
export interface ObservedOrigin {
  asn: number;
  /** Visibility hits for this (prefix, origin) pair. */
  hits: number;
}

/** RAW observation for one monitored prefix — the provider's report, unmodified. A prefix with
 *  no origins was not found in the table (withdrawn / not visible). Multiple origins = MOAS. The
 *  optional fields come from the Prometheus monitoring feed (authoritative visibility + upstreams);
 *  when the connector uses both sources the poller merges them into one observation per prefix. */
export interface RawRoutingObservation {
  prefix: string;
  addressFamily: AddressFamily;
  origins: ObservedOrigin[];
  /** When the provider's data was captured (UTC). */
  observedAt: Date;
  /** Paths bgp.tools sees for the prefix (Prometheus authoritative visibility); null/undefined
   *  when only the table source is used. 0 = present-but-effectively-unseen. */
  visiblePaths?: number | null;
  /** Upstream ASNs currently observed for the prefix (Prometheus); undefined when not available. */
  upstreams?: number[];
  /** Number of upstreams (Prometheus bgptools_prefix_upstreams). */
  upstreamCount?: number | null;
}

/** RADAR's NORMALISED signals for one prefix, derived from the raw observation + expected config.
 *  Every field is traceable to documented bgp.tools data or the operator's expected-origin config —
 *  nothing is inferred from a source we do not have. */
export interface NormalizedRoutingSignal {
  prefix: string;
  addressFamily: AddressFamily;
  expectedOriginAsn: number;
  /** The dominant observed origin (most hits); null when the prefix is withdrawn. */
  observedOriginAsn: number | null;
  observedOrigins: ObservedOrigin[];
  /** observedOriginAsn === expectedOriginAsn (and the expected origin is actually present). */
  originAsExpected: boolean;
  /** No origin observed for the prefix at all — withdrawn / not visible. */
  prefixWithdrawn: boolean;
  /** An origin other than the expected ASN is announcing the prefix (hijack / leak indicator). */
  unexpectedOrigin: boolean;
  /** More than one origin ASN seen for the prefix (Multi-Origin AS). */
  moas: boolean;
  /** Visibility ratio 0..1 — from Prometheus paths ÷ the per-family baseline when available, else
   *  table hits ÷ the hit baseline; null when withdrawn/unknown. */
  prefixVisibilityRatio: number | null;
  /** Raw Prometheus visible-path count (when that source is used). */
  visiblePaths: number | null;
  /** Total visibility hits across all origins for the prefix (table source). */
  observationCount: number;
  /** Upstream ASNs observed now (Prometheus). */
  observedUpstreams: number[];
  upstreamCount: number | null;
  /** Upstreams seen now but not in the learned baseline (previous observation). */
  newUpstreams: number[];
  /** Upstreams in the baseline but not seen now — a lost transit path. */
  missingUpstreams: number[];
  firstObservedAt: Date;
  lastObservedAt: Date;
  sourceConfidence: SourceConfidence;
  /** lastObservedAt is older than the configured freshness window — treat as unknown. */
  stale: boolean;
}

/** RADAR's verdict for one prefix (or, when `prefix` is absent, the overall estate). The `reasons`
 *  are human-readable and each maps to a field in `signals`, so the conclusion is fully explained. */
export interface RoutingIntegrityAssessment {
  /** The prefix this assessment is for; omitted for the overall estate roll-up. */
  prefix?: string;
  state: RoutingIntegrityState;
  reasons: string[];
  /** The evidence the verdict was drawn from (per-prefix assessments only). */
  signals?: NormalizedRoutingSignal;
  assessedAt: Date;
}

/** Counts of prefixes by integrity state — the overview roll-up. */
export interface RoutingIntegrityCounts {
  healthy: number;
  degraded: number;
  critical: number;
  unknown: number;
  total: number;
}

/** The overall routing-intelligence snapshot RADAR presents. */
export interface RoutingIntelligenceSnapshot {
  capturedAt: string; // ISO-8601 UTC
  source: BgpToolsSource;
  /** Worst-severity roll-up across all monitored prefixes. */
  overall: RoutingIntegrityState;
  counts: RoutingIntegrityCounts;
  assessments: RoutingIntegrityAssessment[];
  /** Per-ASN topology from the monitoring feed (peers, upstreams, cone, prefix totals). */
  asns?: AsnMetrics[];
  /** Honest provenance — synthetic vs observed, read-only, and a note. */
  provenance: BgpToolsProvenance;
  /** Non-fatal issues (stale data, prefixes with no expected origin, …). */
  warnings: string[];
}

export interface BgpToolsProvenance {
  source: BgpToolsSource;
  synthetic: boolean;
  readOnly: true;
  note: string;
}

// --- bgp.tools Prometheus monitoring feed (per-account) --------------------------------------
// The account's Prometheus endpoint (prometheus.bgp.tools/prom/<uuid>) exposes real visibility,
// upstream and ASN-topology metrics for the monitored networks. These are the authoritative
// visibility + upstream sources; the table.jsonl dump complements them with explicit origin data
// for hijack/MOAS detection.

/** Per-prefix metrics from the monitoring feed. */
export interface PrefixMetrics {
  prefix: string;
  /** The ASN bgp.tools attributes the prefix to (the metric's `asn` label). */
  originAsn: number;
  /** Paths bgp.tools can see for the prefix (bgptools_asn_prefix_visible) — the visibility count. */
  visiblePaths: number | null;
  /** Number of upstreams for the prefix (bgptools_prefix_upstreams). */
  upstreamCount: number | null;
  /** Upstream ASNs currently seen for the prefix (bgptools_prefix_upstream_seen == 1). */
  upstreams: number[];
}

/** Per-ASN topology metrics from the monitoring feed. */
export interface AsnMetrics {
  asn: number;
  prefixesTotal: number | null;
  prefixesLowVis: number | null;
  cone: number | null;
  upstreams: number | null;
  downstreams: number | null;
  peers: number | null;
}

export interface BgpToolsMetricsSnapshot {
  observedAt: Date;
  prefixes: PrefixMetrics[];
  asns: AsnMetrics[];
}

// Tier-2 active DNS observation contract. RADAR stays the ANALYSIS/CORRELATION plane: it
// verifies what a configured resolver actually returns for a watched record and compares it
// with RADAR's predicted NS1 evaluation. It NEVER writes to NS1 or Cloudflare, never runs
// HTTP/video/traceroute/QoE probes, and never claims anything about actual delivered traffic.
// A single DNS observation is one sample — it is never treated as proof of the probabilistic
// distribution.

/** Representativeness of an observation for the ISP's subscribers. */
export type ObservationConfidence = 'high' | 'medium' | 'low' | 'unknown';

/** Predicted-vs-observed comparison outcome. */
export type ComparisonStatus = 'match' | 'partial_match' | 'mismatch' | 'observation_unavailable' | 'confidence_low' | 'unknown';

/** A single, typed predicted-vs-observed difference. */
export type ComparisonDifferenceKind =
  | 'same_set_different_order'
  | 'missing_predicted_answer'
  | 'unexpected_observed_answer'
  | 'ttl_difference'
  | 'ecs_discrepancy'
  | 'resolver_only_observation'
  | 'partial_radar_evaluation'
  | 'unsupported_record_filter'
  | 'no_response'
  | 'dns_error_response';

export interface ComparisonDifference {
  kind: ComparisonDifferenceKind;
  detail: string;
}

/** Change reason between two consecutive observations (drives the observed-DNS highlight). */
export type ObservationChangeReason =
  | 'observed_answer_set_changed'
  | 'predicted_observed_match_changed'
  | 'ecs_behaviour_changed'
  | 'resolver_changed'
  | 'ttl_changed'
  | 'observation_became_unavailable'
  | 'observation_recovered'
  | 'confidence_changed'
  | 'unknown_change';

export type DnsResponseCode = 'NOERROR' | 'FORMERR' | 'SERVFAIL' | 'NXDOMAIN' | 'REFUSED' | 'OTHER' | 'TIMEOUT' | 'NETWORK_ERROR';

export interface ObservedAnswer {
  type: 'A' | 'AAAA';
  address: string;
}

/** Central RADAR-owned ISP observation scenario. Resolver addresses/ECS subnets are
 *  RADAR-owned config (mock until RTÉ confirms real endpoints); browser input never
 *  contributes. */
export interface DnsObservationScenario {
  ispId: string;
  ispName: string;
  asn: number;
  country: string;
  /** Recursive resolver addresses to query (first is used; others are fallbacks). */
  resolvers: string[];
  /** Representative ECS subnet to request, where approved (CIDR, e.g. `203.0.113.0/24`). */
  ecsSubnet?: string;
  zone: string;
  domain: string;
  recordType: 'A' | 'AAAA';
  /** How representative a direct resolver observation is of real subscribers. */
  expectedRepresentativeness: 'high' | 'medium' | 'low';
  provenance: string;
  notes: string;
}

// --- Transport (the only networked part; injectable for tests) ---------------

export interface DnsQuery {
  resolverIp: string;
  port?: number;
  qname: string;
  qtype: 'A' | 'AAAA';
  /** Requested ECS subnet (CIDR). Omitted → no ECS option sent. */
  ecsSubnet?: string;
  timeoutMs: number;
}

export interface DnsTransportResult {
  responseCode: DnsResponseCode;
  answers: ObservedAnswer[];
  /** Minimum TTL across answers, when present. */
  ttl?: number;
  /** True when the response ECS scope-prefix-length > 0 (authoritative scoped the answer). */
  ecsHonoured: boolean;
}

/** Read-only DNS transport. Implementations perform a single UDP query and never retry
 *  aggressively; a timeout/network failure rejects (mapped to an unavailable observation). */
export interface DnsTransport {
  query(q: DnsQuery): Promise<DnsTransportResult>;
}

// --- Observation (client output, pre-comparison) -----------------------------

export interface RawObservation {
  ispId: string;
  resolverIp?: string;
  responseCode: DnsResponseCode;
  answers: ObservedAnswer[];
  ttl?: number;
  ecsRequested: boolean;
  ecsPrefix?: string;
  ecsHonoured?: boolean;
  latencyMs?: number;
  observedAt: Date;
  /** Non-sensitive notes (never a URL, packet capture or credential). */
  warnings: string[];
  /** When telemetry is disabled, this flags a placeholder (not a real observation). */
  disabled?: boolean;
}

/** Read-only DNS observation client. Returns a RawObservation for a scenario; a total
 *  failure yields an `observation_unavailable`-shaped RawObservation, not an exception. */
export interface DnsObservationClient {
  observe(scenario: DnsObservationScenario, correlationId?: string): Promise<RawObservation>;
  readonly mode: 'disabled' | 'mock' | 'resolver';
}

// --- Prediction & comparison -------------------------------------------------

export interface PredictedAnswer {
  answerId: string;
  addresses: string[];
  deliveryPlatform?: string;
}

export interface PredictedSteering {
  answers: PredictedAnswer[];
  /** Flattened eligible IP set the observation should be drawn from. */
  answerIps: string[];
  distribution: { answerId: string; label: string; deliveryPlatform?: string; share: number }[];
  complete: boolean;
  method?: 'weighted_shuffle' | 'uniform_shuffle' | 'single_answer';
  unsupportedFilters: string[];
  /** True when the terminal filter selects a subset (observed set is a valid sample). */
  expectsSubsetSelection: boolean;
  ttl?: number;
  recordChecksum: string;
}

export interface ComparisonResult {
  comparisonStatus: ComparisonStatus;
  /** Raw set-comparison before the confidence override (match/partial_match/mismatch/unknown). */
  matchStatus: ComparisonStatus;
  confidence: ObservationConfidence;
  differences: ComparisonDifference[];
  explanation: string;
}

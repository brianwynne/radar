// RADAR domain + NS1 types.
//
// Two layers live here, kept separate on purpose (RADAR principle 5.7 — do not
// spread NS1 specifics through the domain):
//   1. NS1* raw types — grounded in the official NS1 Connect Go SDK model
//      (github.com/ns1/ns1-go, rest/model/dns + rest/model/data). Field names and
//      the `filters` chain shape are taken from the SDK, not invented. Unknown
//      fields are preserved (principle 5.3) via index signatures.
//   2. RADAR* model + trace types — source-agnostic; the evaluation output the UI
//      and API consume. No NS1 vocabulary leaks past the evaluator.

/* ------------------------------------------------------------------ NS1 raw */

/** NS1 answer/region metadata. Values may be a literal or a data-feed pointer
 *  `{ feed: <id> }` (SDK: rest/model/data/meta.go). Unknown keys preserved. */
export interface NS1Meta {
  up?: boolean | NS1FeedPtr;
  weight?: number | NS1FeedPtr;
  priority?: number;
  country?: string | string[];
  georegion?: string | string[];
  asn?: number | number[] | NS1FeedPtr;
  ip_prefixes?: string | string[] | NS1FeedPtr;
  note?: string;
  [unknown: string]: unknown;
}
export interface NS1FeedPtr {
  feed: string;
}

/** NS1 answer (SDK: rest/model/dns/answer.go). `answer` holds the rdata. */
export interface NS1Answer {
  id?: string;
  answer: string[];
  meta?: NS1Meta;
  region?: string;
  feeds?: { feed: string; source: string }[];
  [unknown: string]: unknown;
}

/** One filter in the ordered Filter Chain (SDK: rest/model/filter/filter.go).
 *  The JSON key for the type is `filter`; `config` is a free map. */
export interface NS1Filter {
  filter: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  [unknown: string]: unknown;
}

/** NS1 DNS record (SDK: rest/model/dns/record.go). `use_client_subnet` governs
 *  whether NS1 honours EDNS Client Subnet for this record. */
export interface NS1Record {
  id?: string;
  zone: string;
  domain: string;
  type: string;
  ttl?: number;
  use_client_subnet?: boolean;
  answers: NS1Answer[];
  filters: NS1Filter[];
  regions?: Record<string, { meta?: NS1Meta }>;
  meta?: NS1Meta;
  [unknown: string]: unknown;
}

/* -------------------------------------------------------------- RADAR model */

export type IdentitySource = 'ecs' | 'resolver';
export type Confidence = 'high' | 'medium' | 'low';

/** A hypothetical or observed DNS request to evaluate (RADAR §9). In v1 the
 *  country/asn/network are supplied (or overridden); a geo/ASN resolution adapter
 *  replaces the supplied values later — see NS1 assumptions register. */
export interface Scenario {
  record: string; // human label, e.g. "live.rte.ie A"
  resolverIp: string;
  ecsPresent: boolean;
  ecsPrefix?: string;
  country?: string; // ISO 3166-1 alpha-2
  asn?: number;
  clientPrefix?: string;
  network?: string;
  /** answerId -> up, overriding meta.up for simulation. */
  healthOverrides?: Record<string, boolean>;
}

/** What was actually evaluated, and how it was derived (RADAR §8). */
export interface DerivedIdentity {
  sourceUsed: IdentitySource;
  evaluatedAddress: string;
  country?: string;
  asn?: number;
  network?: string;
  prefix?: string;
  confidence: Confidence;
  notes: string[];
}

export type AnswerDisposition =
  | 'retained'
  | 'removed'
  | 'reordered'
  | 'standby'
  | 'selected'
  | 'unsupported';

/** A config-order view of an answer, with the RADAR-friendly delivery platform. */
export interface TracedAnswer {
  id: string;
  label: string;
  deliveryPlatform?: string;
  rdata: string[];
  weight?: number;
  priority?: number;
  region?: string;
}

/** Every input answer to a step is accounted for by exactly one outcome. */
export interface AnswerOutcome {
  answerId: string;
  disposition: AnswerDisposition;
  reason: string;
}

export interface FilterStepTrace {
  index: number;
  type: string;
  disabled: boolean;
  supported: boolean;
  config: Record<string, unknown>;
  metadataConsumed: string[];
  input: string[]; // answer ids entering, in order
  output: string[]; // answer ids leaving, in order
  outcomes: AnswerOutcome[];
  reorder: boolean;
  reason: string;
  confidence: Confidence;
  warning?: string;
}

export interface ExpectedShare {
  answerId: string;
  label: string;
  deliveryPlatform?: string;
  share: number; // 0..1
}

export interface ExpectedDistribution {
  probabilistic: true;
  method: 'weighted_shuffle' | 'uniform_shuffle' | 'single_answer';
  shares: ExpectedShare[];
  disclaimers: string[];
}

/** The complete, explainable evaluation output (RADAR §9). */
export interface EvaluationResult {
  scenario: Scenario;
  identity: DerivedIdentity;
  answers: TracedAnswer[];
  steps: FilterStepTrace[];
  survivors: string[];
  selected?: string;
  expectedDistribution?: ExpectedDistribution;
  certain: boolean;
  warnings: string[];
  unsupportedFilters: string[];
}

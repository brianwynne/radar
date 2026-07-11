// NS1 Connect raw types — grounded in the official NS1 Go SDK (github.com/ns1/ns1-go,
// rest/model/dns + rest/model/data). Field names and the ordered `filters` chain are
// taken from the SDK, not invented (see docs/ns1-assumptions.md). Unknown/extra fields
// are preserved via index signatures (RADAR principle 5.3).
//
// This is the only NS1-specific vocabulary in the engine; everything downstream of the
// evaluator is source-agnostic.

/** A meta value may be a literal or a data-feed pointer `{ feed: <id> }`. */
export interface NS1FeedPtr {
  feed: string;
}

/** NS1 answer/region metadata (SDK: rest/model/data/meta.go). */
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

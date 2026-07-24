// RIPE BGP intelligence — typed internal models. RADAR NEVER exposes raw RIPEstat/RIS response
// shapes to the frontend; the backend normalises them into these records. All reads are from the
// public read-only RIPE APIs (RIPEstat data API + RIS Live). Missing/failed RIPE data is surfaced
// as unknown/partial — NEVER interpreted as a route withdrawal.

export type AddressFamily = 'ipv4' | 'ipv6';

/** RIPEstat routing-status validity/RPKI state; `not-checked` when the RPKI call didn't run/failed. */
export type RpkiState = 'valid' | 'invalid' | 'not-found' | 'not-checked';

/** RADAR's operational verdict for a prefix's external visibility. */
export type RouteHealth =
  | 'healthy' // expected origin + RPKI ok + strong visibility
  | 'degraded' // expected origin but materially reduced visibility / TE degradation
  | 'withdrawn' // RIPE corroborates no route (NOT the same as source-unavailable)
  | 'critical' // unexpected origin or RPKI-invalid
  | 'unknown'; // RIPE source stale/unavailable — monitoring degraded, never "withdrawn"

export type Freshness = 'fresh' | 'stale' | 'unknown';

/** One representative observed AS path (grouped by identical path). Collector peer → … → origin. */
export interface RepresentativePath {
  collector: string; // RRC id, e.g. "RRC00"
  peerAsn: number | null; // the RIS peer's own ASN (first hop of the path)
  asPath: number[]; // e.g. [8218, 39122, 41073]
  count: number; // how many (collector,peer) observations shared this exact path
}

/** Per-collector visibility detail (from the visibility endpoint), for the distribution view. */
export interface CollectorVisibility {
  collector: string;
  city: string | null;
  country: string | null;
  peersSeeing: number;
  peersTotal: number;
}

/** CloudVision correlation is a SEPARATE data source (not yet wired). These fields stay explicitly
 *  unknown until the CloudVision eAPI work lands — RADAR NEVER infers local advertisement from RIPE. */
export interface CloudVisionCorrelation {
  localRoutePresent: 'unknown';
  locallyOriginated: 'unknown';
  advertisedToNeighbours: 'unknown';
  note: string;
}

/** The normalised per-prefix external route-visibility record RADAR presents. */
export interface RouteVisibility {
  prefix: string;
  addressFamily: AddressFamily;
  expectedOrigin: number;
  observedOrigins: number[];
  originAsExpected: boolean;
  unexpectedOrigin: boolean;

  /** RIPE RIS collector peers seeing the route vs eligible (for this family). */
  collectorPeersSeen: number | null;
  collectorPeersEligible: number | null;
  /** peersSeen / peersEligible × 100 — "RIPE RIS collector visibility", NOT "internet visibility". */
  collectorVisibilityPercent: number | null;
  /** Number of RRCs (collectors) that see the route. */
  collectorCount: number | null;
  collectors: CollectorVisibility[];

  rpkiState: RpkiState;
  rpkiMaxLength: number | null;

  representativePaths: RepresentativePath[];
  /** ASN(s) seen immediately before the expected origin across representative paths. */
  upstreams: number[];

  /** A covering less-specific that remains visible (reachability may hold via the aggregate). */
  coveringPrefix: string | null;
  moreSpecifics: string[];

  firstSeen: string | null; // ISO
  lastSeen: string | null; // ISO — last time RIS saw it announced
  /** When the RIPE data itself was current (source-side). */
  sourceObservedAt: string | null;
  /** When RADAR fetched it. */
  sourceFetchedAt: string;
  freshness: Freshness;

  /** RADAR's verdict + traceable reasons. */
  health: RouteHealth;
  reasons: string[];

  cloudVision: CloudVisionCorrelation;

  /** True when one or more RIPE endpoints failed — the record is partial (not authoritative). */
  partial: boolean;
  warnings: string[];
}

export interface RouteVisibilityCounts {
  healthy: number;
  degraded: number;
  withdrawn: number;
  critical: number;
  unknown: number;
  rpkiInvalid: number;
  unexpectedOrigin: number;
  total: number;
}

/** How RADAR reached (or failed to reach) each RIPE source — for the source-health component. */
export interface RipeSourceHealth {
  ripestatReachable: boolean;
  ripestatLastSuccessAt: string | null;
  ripestatLastError: string | null;
  risLiveState: 'connected' | 'reconnecting' | 'disconnected' | 'disabled';
  risLiveLastMessageAt: string | null;
  /** Overall: live / cached / stale / unavailable. */
  status: 'live' | 'cached' | 'stale' | 'unavailable';
}

export interface RouteVisibilitySnapshot {
  capturedAt: string;
  overall: RouteHealth;
  counts: RouteVisibilityCounts;
  prefixes: RouteVisibility[];
  source: RipeSourceHealth;
  warnings: string[];
}

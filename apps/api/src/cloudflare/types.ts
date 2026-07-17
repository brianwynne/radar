// Canonical RADAR model for the Cloudflare Load Balancing layer — the origin-pool selection
// downstream of NS1 (NS1 selects the delivery platform; Cloudflare then selects the origin
// pool). READ-ONLY and INFORMATIONAL: RADAR never writes to Cloudflare. Cloudflare wire shapes
// never escape this module (they live in http-client). A missing value is surfaced as such,
// never invented.

export type CloudflareSource = 'cloudflare' | 'mock' | 'disabled';

export interface CloudflareProvenance {
  source: CloudflareSource;
  synthetic: boolean;
  readOnly: true;
  informationalOnly: true;
  notice: string;
  retrievedAt: string;
}

/** Per-check-region health + RTT for one origin (from the pool health endpoint). */
export interface CloudflareOriginRegionHealth {
  region: string; // Cloudflare check region / PoP, e.g. "WEU"
  healthy: boolean | null;
  rttMs: number | null;
  failureReason: string | null;
}

/** One origin (cache/host) inside a pool. */
export interface CloudflareOrigin {
  name: string;
  address: string;
  weight: number;
  enabled: boolean;
  /** Cloudflare health-monitor verdict; null when not reported. */
  healthy: boolean | null;
  failureReason: string | null;
  /** Host header sent to this origin (origin.header.Host); null when not set. */
  hostHeader: string | null;
  /** Representative response time across healthy check regions (ms); null when not measured. */
  rttMs: number | null;
  /** Per-check-region health + RTT (from the pool health endpoint); empty when unavailable. */
  regionHealth: CloudflareOriginRegionHealth[];
}

/** The health-check (monitor) that decides a pool's health. */
export interface CloudflareHealthCheck {
  type: string; // http | https | tcp | …
  method: string | null;
  path: string | null;
  expectedCodes: string | null;
  expectedBody: string | null;
  intervalSeconds: number | null;
  timeoutSeconds: number | null;
  retries: number | null;
  port: number | null;
  consecutiveUp: number | null;
  consecutiveDown: number | null;
  followRedirects: boolean | null;
  allowInsecure: boolean | null;
}

/** Deliberate traffic shedding configured on a pool. */
export interface CloudflareLoadShedding {
  defaultPercent: number | null;
  defaultPolicy: string | null; // hash | random
  sessionPercent: number | null;
  sessionPolicy: string | null;
}

/** An origin pool (a set of caches Cloudflare can steer to). */
export interface CloudflarePool {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** Overall pool health from Cloudflare; null when not reported. */
  healthy: boolean | null;
  monitorId: string | null;
  /** The resolved health-check spec (why the pool is up/down); null when unknown. */
  healthCheck: CloudflareHealthCheck | null;
  minimumOrigins: number | null;
  origins: CloudflareOrigin[];
  healthyOrigins: number;
  totalOrigins: number;
  /** How origins are chosen within the pool: random | hash | least_outstanding_requests | least_connections. */
  originSteeringPolicy: string | null;
  loadShedding: CloudflareLoadShedding | null;
  /** Cloudflare regions that run this pool's health checks. */
  checkRegions: string[];
  notificationEmail: string | null;
}

/** A pool reference within a load balancer, resolved to its name and configured weight. */
export interface CloudflareSteeredPool {
  poolId: string;
  poolName: string | null;
  /** Configured steering weight (weighted-random policy); null when not weighted. */
  weight: number | null;
}

/** Observed share of a pool/origin/region/PoP from Cloudflare LB analytics. */
export interface CloudflareObservedBucket {
  key: string; // pool name / origin name / region / colo
  requests: number;
  sharePercent: number;
}

/** Observed traffic for a load balancer (from Cloudflare LB analytics, a recent window). */
export interface CloudflareObserved {
  windowHours: number;
  totalRequests: number;
  byPool: CloudflareObservedBucket[];
  byRegion: CloudflareObservedBucket[];
  byColo: CloudflareObservedBucket[];
  /** Which origin (cache) was actually selected — the downstream of pool selection. */
  byOrigin: CloudflareObservedBucket[];
}

/** A load balancer: a hostname whose traffic Cloudflare steers across pools by policy. */
export interface CloudflareLoadBalancer {
  id: string;
  /** Hostname, e.g. "liveedge.rte.ie". */
  name: string;
  zoneName: string | null;
  enabled: boolean;
  proxied: boolean;
  /** off | random | geo | dynamic_latency | proximity | least_outstanding_requests | … */
  steeringPolicy: string;
  defaultPools: CloudflareSteeredPool[];
  fallbackPool: CloudflareSteeredPool | null;
  /** region code → ordered pools (resolved). */
  regionPools: Record<string, CloudflareSteeredPool[]>;
  /** Cloudflare PoP code → ordered pools (resolved). */
  popPools: Record<string, CloudflareSteeredPool[]>;
  /** Country code → ordered pools (resolved). */
  countryPools: Record<string, CloudflareSteeredPool[]>;
  sessionAffinity: string | null;
  sessionAffinityTtl: number | null;
  sessionAffinityAttributes: CloudflareSessionAffinityAttributes | null;
  /** How Cloudflare picks the steering location (e.g. "pop" = the edge PoP the request hit). */
  locationStrategy: string | null;
  /** Whether adaptive routing fails traffic across pools when the selected pool is down. */
  adaptiveRoutingFailoverAcrossPools: boolean | null;
  /** Default weight applied to pools under random steering; null when not weighted. */
  randomSteeringDefaultWeight: number | null;
  ttlSeconds: number | null;
  /** Observed traffic (LB analytics); null when analytics is unavailable or empty. */
  observed: CloudflareObserved | null;
}

export interface CloudflareSessionAffinityAttributes {
  samesite: string | null;
  secure: string | null;
  drainDuration: number | null;
  zeroDowntimeFailover: string | null;
}

export interface CloudflareSummary {
  loadBalancerCount: number;
  poolCount: number;
  originCount: number;
  unhealthyPools: number;
  unhealthyOrigins: number;
}

export interface CloudflareSnapshot {
  source: CloudflareSource;
  capturedAt: string;
  loadBalancers: CloudflareLoadBalancer[];
  pools: CloudflarePool[];
  summary: CloudflareSummary;
  provenance: CloudflareProvenance;
  warnings: string[];
}

/** Fast-refresh data for one pinned pool: per-origin RTT + the regions currently reporting DOWN.
 *  The origin's overall healthy verdict is NOT derived here — Cloudflare's authoritative aggregate
 *  (from the pool object, on the slow snapshot) is the source of truth. A handful of distant check
 *  regions failing (e.g. geo-filtered) does not make an origin unhealthy. */
export interface CloudflareFocusedPoolHealth {
  id: string;
  origins: { address: string; rttMs: number | null; regionHealth: CloudflareOriginRegionHealth[] }[];
}

export interface CloudflareClient {
  getSnapshot(correlationId?: string): Promise<CloudflareSnapshot>;
  /** Fast tier: fetch just the health+RTT for specific pools (bounded — the caller caps the id list). */
  getPoolsHealth(ids: string[], correlationId?: string): Promise<CloudflareFocusedPoolHealth[]>;
}

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

/** One origin (cache/host) inside a pool. */
export interface CloudflareOrigin {
  name: string;
  address: string;
  weight: number;
  enabled: boolean;
  /** Cloudflare health-monitor verdict; null when not reported. */
  healthy: boolean | null;
  failureReason: string | null;
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
  minimumOrigins: number | null;
  origins: CloudflareOrigin[];
  healthyOrigins: number;
  totalOrigins: number;
}

/** A pool reference within a load balancer, resolved to its name where known. */
export interface CloudflareSteeredPool {
  poolId: string;
  poolName: string | null;
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
  sessionAffinity: string | null;
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

export interface CloudflareClient {
  getSnapshot(correlationId?: string): Promise<CloudflareSnapshot>;
}

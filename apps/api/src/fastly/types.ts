// Canonical RADAR model for the Fastly CDN observability layer — a commercial CDN delivery
// platform (one of the platforms NS1 can steer to, alongside the Réalta caches). READ-ONLY and
// INFORMATIONAL: RADAR never writes to Fastly. Fastly wire shapes never escape this module (they
// live in http-client). A missing value is surfaced as such, never invented.

export type FastlySource = 'fastly' | 'mock' | 'disabled';

export interface FastlyProvenance {
  source: FastlySource;
  synthetic: boolean;
  readOnly: true;
  informationalOnly: true;
  notice: string;
  retrievedAt: string;
}

/** A Fastly service (a delivery configuration bound to one or more domains). */
export interface FastlyService {
  id: string;
  name: string;
  version: number | null;
}

/** Aggregated delivery stats for one service over the observation window. */
export interface FastlyServiceStats {
  serviceId: string;
  serviceName: string;
  /** Length of the aggregated window in seconds. */
  windowSeconds: number;
  requests: number;
  requestsPerSecond: number;
  hits: number;
  miss: number;
  /** Edge cache hit ratio (hits / (hits + miss)) as a percentage; null when no cacheable traffic. */
  hitRatioPercent: number | null;
  bandwidthBytes: number;
  /** Bandwidth in bits per second over the window. */
  bandwidthBps: number;
  originFetches: number;
  /** Share of requests served without an origin fetch (1 - originFetches/requests), 0..100; null when no requests. */
  originOffloadPercent: number | null;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  /** 5xx as a percentage of requests; null when no requests. */
  errorRatePercent: number | null;
}

export interface FastlySummary {
  serviceCount: number;
  totalRequestsPerSecond: number;
  totalBandwidthBps: number;
  /** Request-weighted average edge hit ratio across services; null when no cacheable traffic. */
  avgHitRatioPercent: number | null;
}

export interface FastlySnapshot {
  source: FastlySource;
  capturedAt: string;
  services: FastlyServiceStats[];
  summary: FastlySummary;
  provenance: FastlyProvenance;
  warnings: string[];
}

export interface FastlyClient {
  getSnapshot(correlationId?: string): Promise<FastlySnapshot>;
}

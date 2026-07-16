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

// ---- Real-time (per-second) live-tail --------------------------------------------------------
// Sourced from Fastly's real-time analytics host (rt.fastly.com), which streams one aggregated
// bucket per second per service. READ-ONLY: RADAR only long-polls; it never writes. A missing
// counter is surfaced as 0 for that second, never invented across seconds.

/** One-second real-time delivery sample for a single service (Fastly `Data[].aggregated`). */
export interface FastlyRealtimeSample {
  /** Unix epoch seconds of the sampled second (Fastly `recorded`). */
  second: number;
  /** ISO timestamp of `second`. */
  at: string;
  requests: number;
  hits: number;
  miss: number;
  errors: number;
  /** Bytes delivered during this second (response body + headers). */
  bandwidthBytes: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  /** Per specific status code that had traffic this second, e.g. { "200": 680, "206": 40, "404": 12 }.
   *  Enables drilling a class (2xx/3xx/4xx/5xx) down to individual codes; absent codes are simply omitted. */
  statusCodes: Record<string, number>;
}

/** Rolling per-second series for one service over the retention window (oldest first, newest last). */
export interface FastlyRealtimeSeries {
  serviceId: string;
  serviceName: string;
  samples: FastlyRealtimeSample[];
  /** Requests in the most recent second (instantaneous req/s); null when no samples yet. */
  latestRequestsPerSecond: number | null;
  /** Bandwidth of the most recent second in bits/s; null when no samples yet. */
  latestBandwidthBps: number | null;
  /** ISO timestamp of the newest sample; null when empty. */
  lastSampleAt: string | null;
}

export interface FastlyRealtimeSnapshot {
  source: FastlySource;
  capturedAt: string;
  /** Retention window (seconds) each series covers. */
  windowSeconds: number;
  series: FastlyRealtimeSeries[];
  provenance: FastlyProvenance;
  warnings: string[];
}

/** One long-poll batch from a service's real-time channel. */
export interface FastlyRealtimeBatch {
  /** Per-second samples since the requested cursor, oldest first. */
  samples: FastlyRealtimeSample[];
  /** Opaque cursor to pass to the next poll (`.../ts/{nextTimestamp}`). 0 → keep the current cursor. */
  nextTimestamp: number;
  /** Server-reported delay (seconds) before the freshest second is complete. */
  aggregateDelaySeconds: number;
}

/** Read-only real-time client: one long-poll of a service's per-second channel. */
export interface FastlyRealtimeClient {
  pollChannel(
    serviceId: string,
    sinceTimestamp: number,
    opts?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<FastlyRealtimeBatch>;
}

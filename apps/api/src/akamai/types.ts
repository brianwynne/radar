// Canonical RADAR model for the Akamai CDN observability layer — a commercial CDN delivery platform
// (one NS1 can steer to, alongside Fastly and the Réalta caches). Akamai has no per-second pull API;
// telemetry arrives as DataStream 2 edge-log records (pushed to S3, pulled by RADAR) which RADAR
// aggregates into per-CP-code per-second metrics. READ-ONLY and INFORMATIONAL: RADAR never writes to
// Akamai. Shapes deliberately mirror the Fastly realtime model so the UI (response-code panel +
// drill-down) is shared. A missing value is surfaced as such, never invented.

export type AkamaiSource = 'akamai' | 'disabled';

export interface AkamaiProvenance {
  source: AkamaiSource;
  synthetic: boolean;
  readOnly: true;
  informationalOnly: true;
  notice: string;
  retrievedAt: string;
}

/** One DataStream 2 edge-log record, reduced to the fields RADAR aggregates. */
export interface DataStreamRecord {
  /** Unix epoch seconds the edge accepted the request (DS2 `reqTimeSec`). */
  second: number;
  /** CP code (DS2 `cp`) — Akamai's "service". */
  cp: string;
  /** Content bytes served in the response body (DS2 `bytes`). */
  bytes: number;
  /** true when served from edge cache (DS2 `cacheStatus` === 1). */
  hit: boolean;
  /** HTTP status code (DS2 `statusCode`); 0 when the connection ended before a response. */
  statusCode: number;
}

/** One-second aggregate for a single CP code. Mirrors FastlyRealtimeSample. */
export interface AkamaiSample {
  second: number;
  at: string;
  requests: number;
  hits: number;
  miss: number;
  bandwidthBytes: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  /** Per specific status code with traffic this second, e.g. { "200": 680, "206": 40 }. */
  statusCodes: Record<string, number>;
}

/** Rolling per-second series for one CP code (oldest first, newest last). */
export interface AkamaiSeries {
  serviceId: string; // CP code
  serviceName: string; // CP code name (e.g. LIVE.RTE.IE), else the code
  samples: AkamaiSample[];
  latestRequestsPerSecond: number | null;
  latestBandwidthBps: number | null;
  lastSampleAt: string | null;
}

export interface AkamaiSnapshot {
  source: AkamaiSource;
  capturedAt: string;
  windowSeconds: number;
  series: AkamaiSeries[];
  provenance: AkamaiProvenance;
  warnings: string[];
}

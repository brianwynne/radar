// Source-independent network-path telemetry contract. RADAR's domain and UI depend only on
// these types — never on Prometheus (or any other backend) query syntax. Telemetry is
// READ-ONLY and INFORMATIONAL: it never triggers an NS1 write and never changes persisted
// steering state. Capacity/target are RADAR-CONFIGURED; rates/utilisation are OBSERVED — the
// two are always kept distinct so observed data is never confused with configuration.

/** Path categories RADAR reports utilisation for. */
export type PathType = 'PNI' | 'INEX' | 'transit';

/** Which direction's rate drives the steering-capacity utilisation for a path. */
export type TelemetryDirection = 'inbound' | 'outbound';

/** Where a sample came from (never a URL or credential). */
export type TelemetrySource = 'mock' | 'prometheus' | 'disabled';

/** Health classification. `telemetry_not_connected` = telemetry disabled; `unavailable` =
 *  telemetry enabled but no fresh value could be obtained; `stale` = a value exists but is
 *  older than the freshness window. */
export type TelemetryStatus =
  | 'healthy'
  | 'above_target'
  | 'warning'
  | 'critical'
  | 'unavailable'
  | 'stale'
  | 'telemetry_not_connected';

/** RADAR-owned mapping of a logical path to its telemetry source + configured envelope.
 *  This is the ONLY place a path is bound to an interface/query; browser input never
 *  contributes to it. */
export interface PathMapping {
  /** Stable RADAR path id (e.g. `eir-pni`). */
  id: string;
  /** Human display name; matches the Live Steering preferred-path label (e.g. `Eir PNI`). */
  name: string;
  type: PathType;
  /** Interface or logical-link identity/selector (used to build the source query). */
  interfaceIdentity: string;
  /** Configured link capacity in bits per second. */
  configuredCapacityBps: number;
  /** Configured preferred-utilisation target (percent, 0..100). */
  configuredTargetPercent: number;
  /** Warning threshold (percent). */
  warningThresholdPercent: number;
  /** Critical threshold (percent). */
  criticalThresholdPercent: number;
  /** Direction whose rate is the primary steering-capacity measure (default outbound). */
  direction: TelemetryDirection;
}

/** A raw observation for one path from a telemetry source (before RADAR classification).
 *  `null` rates mean the source returned no usable data for that path. */
export interface PathObservation {
  inboundBps: number | null;
  outboundBps: number | null;
  /** When the source observed the value. */
  observedAt: Date | null;
  /** Non-sensitive notes (e.g. "inbound series missing"). Never a URL/credential. */
  warnings?: string[];
}

export interface SampleProvenance {
  source: TelemetrySource;
  /** True for mock/synthetic data — never real production telemetry. */
  synthetic: boolean;
  readOnly: true;
  informationalOnly: true;
  note: string;
}

export interface TelemetryFreshness {
  /** Age of the observation in seconds (null when there is no observation). */
  ageSeconds: number | null;
  /** Window after which an observation is considered stale. */
  staleAfterSeconds: number;
  /** True when a fresh observation exists. */
  fresh: boolean;
}

/** A fully-classified telemetry sample for one path. */
export interface NetworkPathSample {
  pathId: string;
  pathName: string;
  pathType: PathType;
  interfaceIdentity: string;
  // Configured (RADAR-owned) — never observed.
  configuredCapacityBps: number;
  configuredTargetPercent: number;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  direction: TelemetryDirection;
  // Observed (from the source) — never configuration.
  observedInboundBps: number | null;
  observedOutboundBps: number | null;
  /** Utilisation of the primary direction against configured capacity (percent, or null). */
  observedUtilisationPercent: number | null;
  observedAt: string | null;
  // Derived.
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  source: TelemetrySource;
  warnings: string[];
  provenance: SampleProvenance;
}

/** Portable telemetry client. Implementations return fully-classified samples for the
 *  configured paths; a total upstream failure yields `unavailable` samples (never an
 *  invented value), not an exception. */
export interface NetworkPathTelemetryClient {
  /** Latest sample for every configured path. */
  getNetworkPaths(correlationId?: string): Promise<NetworkPathSample[]>;
  /** Latest sample for one path, or null if the path id is unknown. */
  getNetworkPath(pathId: string, correlationId?: string): Promise<NetworkPathSample | null>;
}

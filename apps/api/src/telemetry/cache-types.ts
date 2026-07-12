// Source-independent Réalta cache-pool / cache-node / origin telemetry contract. Same
// portable-adapter pattern as the network-path telemetry: the RADAR domain and UI depend
// only on these types, never on a backend's query syntax. READ-ONLY and INFORMATIONAL —
// never writes to NS1 or Cloudflare, and never changes persisted steering state. Configured
// capacity/node-counts are MANUALLY MAINTAINED; throughput/CPU/hit-ratio are OBSERVED — kept
// strictly distinct.
import type { SampleProvenance, TelemetryFreshness, TelemetrySource, TelemetryStatus } from './types.js';

/** RADAR-owned configuration for a Réalta cache pool. The ONE place a pool's site, node
 *  count and capacity are defined (manually maintained; never observed). */
export interface CachePoolMapping {
  id: string;
  name: string;
  site: string;
  /** Configured number of cache nodes (manually maintained). */
  cacheNodeCount: number;
  /** Configured aggregate outbound capacity (bps, manually maintained). */
  configuredCapacityBps: number;
  /** Throughput/CPU thresholds (percent). */
  targetPercent: number;
  warningPercent: number;
  criticalPercent: number;
}

/** RADAR-owned configuration for one cache node within a pool. */
export interface CacheNodeMapping {
  id: string;
  name: string;
  poolId: string;
  site: string;
  configuredCapacityBps: number;
  targetPercent: number;
  warningPercent: number;
  criticalPercent: number;
}

/** RADAR-owned configuration for the origin. Origin has no configured egress cap here. */
export interface OriginMapping {
  id: string;
  name: string;
  targetPercent: number;
  warningPercent: number;
  criticalPercent: number;
}

/** A raw observation for a pool/node (before classification). `null` = no usable data. */
export interface CacheObservation {
  outboundBps: number | null;
  cpuUtilisationPercent: number | null;
  memoryUtilisationPercent: number | null;
  /** Cache hit ratio as a fraction 0..1. */
  cacheHitRatio: number | null;
  /** Requests per second. */
  requestRate: number | null;
  observedAt: Date | null;
  warnings?: string[];
}

export interface OriginObservation {
  requestRate: number | null;
  outboundBandwidthBps: number | null;
  cpuUtilisationPercent: number | null;
  observedAt: Date | null;
  warnings?: string[];
}

export interface CachePoolSample {
  poolId: string;
  poolName: string;
  site: string;
  // Configured (manually maintained) — never observed.
  cacheNodeCount: number;
  configuredCapacityBps: number;
  targetPercent: number;
  warningPercent: number;
  criticalPercent: number;
  // Observed.
  observedOutboundBps: number | null;
  observedUtilisationPercent: number | null;
  cpuUtilisationPercent: number | null;
  memoryUtilisationPercent: number | null;
  cacheHitRatio: number | null;
  requestRate: number | null;
  observedAt: string | null;
  // Derived. Headroom = configuredCapacity − observedOutbound (null if either unavailable).
  headroomBps: number | null;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  source: TelemetrySource;
  warnings: string[];
  provenance: SampleProvenance;
}

export interface CacheNodeSample {
  nodeId: string;
  nodeName: string;
  poolId: string;
  site: string;
  configuredCapacityBps: number;
  targetPercent: number;
  warningPercent: number;
  criticalPercent: number;
  observedOutboundBps: number | null;
  observedUtilisationPercent: number | null;
  cpuUtilisationPercent: number | null;
  memoryUtilisationPercent: number | null;
  cacheHitRatio: number | null;
  requestRate: number | null;
  observedAt: string | null;
  headroomBps: number | null;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  source: TelemetrySource;
  warnings: string[];
  provenance: SampleProvenance;
}

export interface OriginSample {
  originId: string;
  originName: string;
  requestRate: number | null;
  outboundBandwidthBps: number | null;
  cpuUtilisationPercent: number | null;
  observedAt: string | null;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  source: TelemetrySource;
  warnings: string[];
  provenance: SampleProvenance;
}

/** Portable cache/origin telemetry client. Implementations return fully-classified samples;
 *  a total upstream failure yields `unavailable` samples (never an invented value), not an
 *  exception. There is deliberately NO write/mutate method. */
export interface CacheTelemetryClient {
  getCachePools(correlationId?: string): Promise<CachePoolSample[]>;
  getCachePool(poolId: string, correlationId?: string): Promise<CachePoolSample | null>;
  getCacheNodes(correlationId?: string): Promise<CacheNodeSample[]>;
  getCacheNode(nodeId: string, correlationId?: string): Promise<CacheNodeSample | null>;
  getOrigin(correlationId?: string): Promise<OriginSample>;
}

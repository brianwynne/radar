// bgp.tools read-client contract. Any provider (mock now; a documented-export HTTP client in a
// later slice) implements this. READ-ONLY: the interface exposes no mutation. The client only
// FETCHES raw table data for the monitored prefixes; all interpretation happens in the adapter.
import type { BgpToolsMetricsSnapshot, MonitoredPrefix, RawRoutingObservation } from './types.js';

export interface BgpToolsPing {
  ok: boolean;
  /** Human-readable detail (e.g. "reached table.jsonl", or the failure reason). Never a secret. */
  detail: string;
}

export interface BgpToolsReadClient {
  /** Fetch the current table observation for each monitored prefix. A prefix absent from the
   *  provider's table is returned with an empty `origins` array (withdrawn / not visible). */
  fetchObservations(prefixes: MonitoredPrefix[]): Promise<RawRoutingObservation[]>;
  /** Cheap liveness/authorisation check for the "Test connection" button. */
  ping(): Promise<BgpToolsPing>;
}

/** The Prometheus monitoring feed client contract (authoritative visibility + upstreams). */
export interface BgpToolsMetricsClient {
  fetchMetrics(): Promise<BgpToolsMetricsSnapshot>;
  ping(): Promise<BgpToolsPing>;
}

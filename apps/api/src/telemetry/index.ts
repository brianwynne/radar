// Network-path telemetry module. The factory selects the disabled placeholder, the
// deterministic mock, or the read-only Prometheus adapter from configuration, and wraps it
// in a short-lived in-memory cache (latest observed value only — no high-frequency history
// is persisted; historical telemetry stays with the source monitoring platform).
import type { TelemetryConfig } from './config.js';
import { resolveMappings } from './paths.js';
import { DisabledNetworkPathTelemetryClient, MockNetworkPathTelemetryClient } from './mock-client.js';
import { PrometheusNetworkPathTelemetryClient } from './prometheus-client.js';
import type { NetworkPathSample, NetworkPathTelemetryClient } from './types.js';

export type { TelemetryConfig, TelemetryMode, PrometheusAuth } from './config.js';
export { loadTelemetryConfig } from './config.js';
export { TelemetryError, type TelemetryErrorCode } from './errors.js';
export { NETWORK_PATH_MAPPINGS, resolveMappings } from './paths.js';
export { buildSample, utilisationPercent, classifyUtilisation } from './sample.js';
export { MockNetworkPathTelemetryClient, DisabledNetworkPathTelemetryClient } from './mock-client.js';
export { PrometheusNetworkPathTelemetryClient } from './prometheus-client.js';
export type * from './types.js';

/** Short-lived cache: caches the full path list for `ttlSeconds`; `getNetworkPath` reads
 *  the cached list. Only the latest value is kept. On a refresh failure the last value is
 *  NOT served as fresh — the underlying client already degrades to `unavailable` samples,
 *  so failures surface honestly rather than as silently-stale caches. */
export class CachingTelemetryClient implements NetworkPathTelemetryClient {
  private cache: { at: number; value: NetworkPathSample[] } | null = null;

  constructor(
    private readonly inner: NetworkPathTelemetryClient,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private fresh(): boolean {
    return this.cache !== null && this.now() - this.cache.at < this.ttlSeconds * 1000;
  }

  async getNetworkPaths(correlationId?: string): Promise<NetworkPathSample[]> {
    if (this.fresh()) return this.cache!.value;
    const value = await this.inner.getNetworkPaths(correlationId);
    this.cache = { at: this.now(), value };
    return value;
  }

  async getNetworkPath(pathId: string, correlationId?: string): Promise<NetworkPathSample | null> {
    const all = await this.getNetworkPaths(correlationId);
    return all.find((s) => s.pathId === pathId) ?? null;
  }
}

export interface TelemetryClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Build the configured telemetry client (disabled/mock/prometheus), cache-wrapped. */
export function createTelemetryClient(config: TelemetryConfig, deps: TelemetryClientDeps = {}): NetworkPathTelemetryClient {
  const mappings = resolveMappings({ warningPercent: config.warningPercent, criticalPercent: config.criticalPercent });
  let inner: NetworkPathTelemetryClient;
  if (config.mode === 'mock') {
    inner = new MockNetworkPathTelemetryClient({ mappings, staleAfterSeconds: config.staleAfterSeconds, now: deps.now });
  } else if (config.mode === 'prometheus' && config.prometheus) {
    inner = new PrometheusNetworkPathTelemetryClient({
      baseUrl: config.prometheus.baseUrl,
      queryTemplate: config.prometheus.queryPathUtilisation,
      auth: config.prometheus.auth,
      timeoutMs: config.prometheus.requestTimeoutMs,
      maxRetries: config.prometheus.maxRetries,
      mappings,
      staleAfterSeconds: config.staleAfterSeconds,
      now: deps.now,
      fetchImpl: deps.fetchImpl,
    });
  } else {
    inner = new DisabledNetworkPathTelemetryClient(mappings, config.staleAfterSeconds);
  }
  return new CachingTelemetryClient(inner, config.cacheTtlSeconds, deps.now);
}

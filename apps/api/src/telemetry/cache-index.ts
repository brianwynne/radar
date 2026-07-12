// Cache/origin telemetry module. Factory selects disabled/mock/prometheus from config and
// wraps it in a short-lived in-memory cache (latest value only; no telemetry persisted).
import type { CacheTelemetryConfig } from './cache-config.js';
import { resolveNodeMappings, resolveOriginMapping, resolvePoolMappings } from './pools.js';
import { DisabledCacheTelemetryClient, MockCacheTelemetryClient } from './cache-mock-client.js';
import { PrometheusCacheTelemetryClient } from './cache-prometheus-client.js';
import type { CacheNodeSample, CachePoolSample, CacheTelemetryClient, OriginSample } from './cache-types.js';

export { loadCacheTelemetryConfig, type CacheTelemetryConfig, type CacheQueryTemplates } from './cache-config.js';
export { CACHE_POOL_MAPPINGS, CACHE_NODE_MAPPINGS, ORIGIN_MAPPING } from './pools.js';
export { buildPoolSample, buildNodeSample, buildOriginSample, headroom } from './cache-sample.js';
export { MockCacheTelemetryClient, DisabledCacheTelemetryClient } from './cache-mock-client.js';
export { PrometheusCacheTelemetryClient } from './cache-prometheus-client.js';
export type * from './cache-types.js';

/** Short-lived per-collection cache (pools/nodes/origin). Latest value only; failures are
 *  not masked — the underlying client already degrades to `unavailable`/`telemetry_not_
 *  connected` samples, so honesty is preserved. */
export class CachingCacheTelemetryClient implements CacheTelemetryClient {
  private pools: { at: number; value: CachePoolSample[] } | null = null;
  private nodes: { at: number; value: CacheNodeSample[] } | null = null;
  private origin: { at: number; value: OriginSample } | null = null;

  constructor(
    private readonly inner: CacheTelemetryClient,
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private fresh(at: number | undefined): boolean {
    return at !== undefined && this.now() - at < this.ttlSeconds * 1000;
  }

  async getCachePools(cid?: string): Promise<CachePoolSample[]> {
    if (this.pools && this.fresh(this.pools.at)) return this.pools.value;
    const value = await this.inner.getCachePools(cid);
    this.pools = { at: this.now(), value };
    return value;
  }
  async getCachePool(poolId: string, cid?: string): Promise<CachePoolSample | null> {
    return (await this.getCachePools(cid)).find((p) => p.poolId === poolId) ?? null;
  }
  async getCacheNodes(cid?: string): Promise<CacheNodeSample[]> {
    if (this.nodes && this.fresh(this.nodes.at)) return this.nodes.value;
    const value = await this.inner.getCacheNodes(cid);
    this.nodes = { at: this.now(), value };
    return value;
  }
  async getCacheNode(nodeId: string, cid?: string): Promise<CacheNodeSample | null> {
    return (await this.getCacheNodes(cid)).find((n) => n.nodeId === nodeId) ?? null;
  }
  async getOrigin(cid?: string): Promise<OriginSample> {
    if (this.origin && this.fresh(this.origin.at)) return this.origin.value;
    const value = await this.inner.getOrigin(cid);
    this.origin = { at: this.now(), value };
    return value;
  }
}

export interface CacheTelemetryClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createCacheTelemetryClient(config: CacheTelemetryConfig, deps: CacheTelemetryClientDeps = {}): CacheTelemetryClient {
  const overrides = { warningPercent: config.warningPercent, criticalPercent: config.criticalPercent };
  const pools = resolvePoolMappings(overrides);
  const nodes = resolveNodeMappings(overrides);
  const origin = resolveOriginMapping(overrides);

  let inner: CacheTelemetryClient;
  if (config.mode === 'mock') {
    inner = new MockCacheTelemetryClient({ pools, nodes, origin, staleAfterSeconds: config.staleAfterSeconds, now: deps.now });
  } else if (config.mode === 'prometheus' && config.prometheus) {
    inner = new PrometheusCacheTelemetryClient({
      baseUrl: config.prometheus.baseUrl,
      auth: config.prometheus.auth,
      timeoutMs: config.prometheus.requestTimeoutMs,
      maxRetries: config.prometheus.maxRetries,
      queries: config.prometheus.queries,
      pools, nodes, origin,
      staleAfterSeconds: config.staleAfterSeconds,
      now: deps.now,
      fetchImpl: deps.fetchImpl,
    });
  } else {
    inner = new DisabledCacheTelemetryClient(pools, nodes, origin, config.staleAfterSeconds);
  }
  return new CachingCacheTelemetryClient(inner, config.cacheTtlSeconds, deps.now);
}

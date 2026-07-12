// Deterministic, clearly-synthetic cache/origin telemetry. Values are fixed (no randomness)
// and always labelled MOCK / SYNTHETIC via the sample provenance. Never presented as real
// telemetry. Covers the healthy→critical range plus stale/unavailable scenarios.
import { buildNodeSample, buildOriginSample, buildPoolSample } from './cache-sample.js';
import type {
  CacheNodeMapping, CacheNodeSample, CacheObservation, CachePoolMapping, CachePoolSample,
  CacheTelemetryClient, OriginMapping, OriginObservation, OriginSample,
} from './cache-types.js';

interface PoolScenario { util: number; cpu: number; mem: number; hit: number; req: number }

/** Deterministic per-pool scenarios: a healthy→critical spread. */
export const MOCK_POOL_SCENARIOS: Record<string, PoolScenario> = {
  'donnybrook-1': { util: 0.5, cpu: 55, mem: 60, hit: 0.96, req: 42000 }, // healthy
  'donnybrook-2': { util: 0.74, cpu: 72, mem: 68, hit: 0.94, req: 61000 }, // above_target
  'external-1': { util: 0.84, cpu: 85, mem: 74, hit: 0.9, req: 180000 }, // warning
  'external-2': { util: 0.95, cpu: 94, mem: 88, hit: 0.88, req: 210000 }, // critical
};

export interface MockCacheTelemetryOptions {
  pools: CachePoolMapping[];
  nodes: CacheNodeMapping[];
  origin: OriginMapping;
  staleAfterSeconds: number;
  now?: () => number;
  scenarios?: Record<string, PoolScenario>;
  unavailablePoolIds?: string[];
  stalePoolIds?: string[];
  unavailableNodeIds?: string[];
  origin_?: { cpu: number; req: number; bw: number } | 'unavailable';
}

export class MockCacheTelemetryClient implements CacheTelemetryClient {
  private readonly now: () => number;
  private readonly scen: Record<string, PoolScenario>;
  private readonly unavailablePools: Set<string>;
  private readonly stalePools: Set<string>;
  private readonly unavailableNodes: Set<string>;

  constructor(private readonly opts: MockCacheTelemetryOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.scen = opts.scenarios ?? MOCK_POOL_SCENARIOS;
    this.unavailablePools = new Set(opts.unavailablePoolIds ?? []);
    this.stalePools = new Set(opts.stalePoolIds ?? []);
    this.unavailableNodes = new Set(opts.unavailableNodeIds ?? []);
  }

  private ctx() {
    return { now: this.now(), staleAfterSeconds: this.opts.staleAfterSeconds, source: 'mock' as const, synthetic: true };
  }

  private cacheObs(scenario: PoolScenario, capacityBps: number, stale: boolean): CacheObservation {
    const now = this.now();
    const ageMs = stale ? (this.opts.staleAfterSeconds + 60) * 1000 : 0;
    return {
      outboundBps: Math.round(capacityBps * scenario.util),
      cpuUtilisationPercent: scenario.cpu,
      memoryUtilisationPercent: scenario.mem,
      cacheHitRatio: scenario.hit,
      requestRate: scenario.req,
      observedAt: new Date(now - ageMs),
    };
  }

  private poolSample(mapping: CachePoolMapping): CachePoolSample {
    if (this.unavailablePools.has(mapping.id)) return buildPoolSample(mapping, null, this.ctx());
    const scenario = this.scen[mapping.id] ?? { util: 0.5, cpu: 50, mem: 50, hit: 0.9, req: 50000 };
    return buildPoolSample(mapping, this.cacheObs(scenario, mapping.configuredCapacityBps, this.stalePools.has(mapping.id)), this.ctx());
  }

  private nodeSample(mapping: CacheNodeMapping): CacheNodeSample {
    if (this.unavailableNodes.has(mapping.id)) return buildNodeSample(mapping, null, this.ctx());
    const poolScenario = this.scen[mapping.poolId] ?? { util: 0.5, cpu: 50, mem: 50, hit: 0.9, req: 50000 };
    // Per-node deterministic variation (by node index) so nodes are not identical.
    const idx = Number(mapping.id.slice(-1)) || 1;
    const nodeScenario: PoolScenario = { ...poolScenario, cpu: Math.min(99, poolScenario.cpu + (idx - 1) * 2), req: Math.round(poolScenario.req / 2) };
    return buildNodeSample(mapping, this.cacheObs(nodeScenario, mapping.configuredCapacityBps, this.stalePools.has(mapping.poolId)), this.ctx());
  }

  async getCachePools(): Promise<CachePoolSample[]> {
    return this.opts.pools.map((p) => this.poolSample(p));
  }
  async getCachePool(poolId: string): Promise<CachePoolSample | null> {
    const m = this.opts.pools.find((p) => p.id === poolId);
    return m ? this.poolSample(m) : null;
  }
  async getCacheNodes(): Promise<CacheNodeSample[]> {
    return this.opts.nodes.map((n) => this.nodeSample(n));
  }
  async getCacheNode(nodeId: string): Promise<CacheNodeSample | null> {
    const m = this.opts.nodes.find((n) => n.id === nodeId);
    return m ? this.nodeSample(m) : null;
  }
  async getOrigin(): Promise<OriginSample> {
    if (this.opts.origin_ === 'unavailable') return buildOriginSample(this.opts.origin, null, this.ctx());
    const o = this.opts.origin_ ?? { cpu: 62, req: 9000, bw: 120_000_000_000 };
    const obs: OriginObservation = { requestRate: o.req, outboundBandwidthBps: o.bw, cpuUtilisationPercent: o.cpu, observedAt: new Date(this.now()) };
    return buildOriginSample(this.opts.origin, obs, this.ctx());
  }
}

/** Telemetry-disabled client: configured pools/nodes/origin with telemetry_not_connected. */
export class DisabledCacheTelemetryClient implements CacheTelemetryClient {
  constructor(
    private readonly pools: CachePoolMapping[],
    private readonly nodes: CacheNodeMapping[],
    private readonly origin: OriginMapping,
    private readonly staleAfterSeconds: number,
  ) {}

  private ctx() {
    return { now: 0, staleAfterSeconds: this.staleAfterSeconds, source: 'disabled' as const, synthetic: false };
  }
  async getCachePools(): Promise<CachePoolSample[]> {
    return this.pools.map((p) => buildPoolSample(p, null, this.ctx()));
  }
  async getCachePool(poolId: string): Promise<CachePoolSample | null> {
    const m = this.pools.find((p) => p.id === poolId);
    return m ? buildPoolSample(m, null, this.ctx()) : null;
  }
  async getCacheNodes(): Promise<CacheNodeSample[]> {
    return this.nodes.map((n) => buildNodeSample(n, null, this.ctx()));
  }
  async getCacheNode(nodeId: string): Promise<CacheNodeSample | null> {
    const m = this.nodes.find((n) => n.id === nodeId);
    return m ? buildNodeSample(m, null, this.ctx()) : null;
  }
  async getOrigin(): Promise<OriginSample> {
    return buildOriginSample(this.origin, null, this.ctx());
  }
}

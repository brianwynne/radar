// Read-only Prometheus cache/origin telemetry adapter. Each metric is an independent
// instant query built ONLY from a RADAR-owned template ($POOL / $NODE substituted server-
// side). A missing template means the metric is simply not observed (never fabricated); a
// per-target hard failure yields an `unavailable` sample so the API still lists every
// configured pool/node. Credentials are never logged or returned.
import { PrometheusHttp } from './prometheus-http.js';
import { buildNodeSample, buildOriginSample, buildPoolSample } from './cache-sample.js';
import type { CacheQueryTemplates } from './cache-config.js';
import type { PrometheusAuth } from './config.js';
import type {
  CacheNodeMapping, CacheNodeSample, CacheObservation, CachePoolMapping, CachePoolSample,
  CacheTelemetryClient, OriginMapping, OriginObservation, OriginSample,
} from './cache-types.js';

export interface CachePrometheusOptions {
  baseUrl: string;
  auth: PrometheusAuth;
  timeoutMs: number;
  maxRetries: number;
  queries: CacheQueryTemplates;
  pools: CachePoolMapping[];
  nodes: CacheNodeMapping[];
  origin: OriginMapping;
  staleAfterSeconds: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class PrometheusCacheTelemetryClient implements CacheTelemetryClient {
  private readonly http: PrometheusHttp;
  private readonly now: () => number;

  constructor(private readonly opts: CachePrometheusOptions) {
    this.http = new PrometheusHttp({ baseUrl: opts.baseUrl, auth: opts.auth, timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries, fetchImpl: opts.fetchImpl, sleep: opts.sleep, random: opts.random });
    this.now = opts.now ?? (() => Date.now());
  }

  private ctx() {
    return { now: this.now(), staleAfterSeconds: this.opts.staleAfterSeconds, source: 'prometheus' as const, synthetic: false };
  }

  /** Run one metric query (substituting a placeholder) → value or null; a hard failure is
   *  surfaced as null with a warning (the sample degrades to unavailable, honestly). */
  private async metric(template: string | undefined, placeholder: string, value: string, label: string, warnings: string[], cid?: string): Promise<{ value: number; atMs: number } | null> {
    if (!template) return null;
    try {
      return await this.http.queryInstant(template.replaceAll(placeholder, value), cid);
    } catch {
      warnings.push(`${label} query failed.`);
      return null;
    }
  }

  private async cacheObservation(placeholder: string, id: string, cid?: string): Promise<CacheObservation | null> {
    const q = this.opts.queries;
    const warnings: string[] = [];
    const throughput = await this.metric(placeholder === '$POOL' ? q.poolThroughput : q.nodeThroughput, placeholder, id, 'throughput', warnings, cid);
    // Throughput is the anchor metric; without it there is no usable observation.
    if (throughput === null) return null;
    const cpu = await this.metric(placeholder === '$POOL' ? q.poolCpu : q.nodeCpu, placeholder, id, 'cpu', warnings, cid);
    const mem = await this.metric(placeholder === '$POOL' ? q.poolMemory : q.nodeMemory, placeholder, id, 'memory', warnings, cid);
    const hit = await this.metric(placeholder === '$POOL' ? q.poolHitRatio : q.nodeHitRatio, placeholder, id, 'hit-ratio', warnings, cid);
    const req = await this.metric(placeholder === '$POOL' ? q.poolRequestRate : q.nodeRequestRate, placeholder, id, 'request-rate', warnings, cid);
    return {
      outboundBps: throughput.value,
      cpuUtilisationPercent: cpu?.value ?? null,
      memoryUtilisationPercent: mem?.value ?? null,
      cacheHitRatio: hit?.value ?? null,
      requestRate: req?.value ?? null,
      observedAt: new Date(throughput.atMs),
      warnings,
    };
  }

  private async poolSample(mapping: CachePoolMapping, cid?: string): Promise<CachePoolSample> {
    return buildPoolSample(mapping, await this.cacheObservation('$POOL', mapping.id, cid), this.ctx());
  }
  private async nodeSample(mapping: CacheNodeMapping, cid?: string): Promise<CacheNodeSample> {
    return buildNodeSample(mapping, await this.cacheObservation('$NODE', mapping.id, cid), this.ctx());
  }

  async getCachePools(cid?: string): Promise<CachePoolSample[]> {
    return Promise.all(this.opts.pools.map((p) => this.poolSample(p, cid)));
  }
  async getCachePool(poolId: string, cid?: string): Promise<CachePoolSample | null> {
    const m = this.opts.pools.find((p) => p.id === poolId);
    return m ? this.poolSample(m, cid) : null;
  }
  async getCacheNodes(cid?: string): Promise<CacheNodeSample[]> {
    return Promise.all(this.opts.nodes.map((n) => this.nodeSample(n, cid)));
  }
  async getCacheNode(nodeId: string, cid?: string): Promise<CacheNodeSample | null> {
    const m = this.opts.nodes.find((n) => n.id === nodeId);
    return m ? this.nodeSample(m, cid) : null;
  }
  async getOrigin(cid?: string): Promise<OriginSample> {
    const q = this.opts.queries;
    const warnings: string[] = [];
    const cpu = await this.metric(q.originCpu, '$ORIGIN', this.opts.origin.id, 'origin-cpu', warnings, cid);
    // CPU is the origin anchor metric; without it there is no usable observation.
    if (cpu === null) return buildOriginSample(this.opts.origin, null, this.ctx());
    const req = await this.metric(q.originRequestRate, '$ORIGIN', this.opts.origin.id, 'origin-request-rate', warnings, cid);
    const bw = await this.metric(q.originBandwidth, '$ORIGIN', this.opts.origin.id, 'origin-bandwidth', warnings, cid);
    const obs: OriginObservation = { cpuUtilisationPercent: cpu.value, requestRate: req?.value ?? null, outboundBandwidthBps: bw?.value ?? null, observedAt: new Date(cpu.atMs), warnings };
    return buildOriginSample(this.opts.origin, obs, this.ctx());
  }
}

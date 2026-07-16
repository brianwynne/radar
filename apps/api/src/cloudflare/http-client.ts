// Live, READ-ONLY Cloudflare Load Balancing client. GET-only over HTTPS with a Bearer token
// that is never logged, an explicit timeout, and bounded retry-with-jitter for transient
// failures. There is NO method that issues a non-GET request. Cloudflare wire shapes are mapped
// to RADAR's canonical model here and never escape this module.
//
// APIs used (all read):
//   GET /accounts/{account}/load_balancers/pools           — pools + origins + health
//   GET /zones?per_page=50&page=N                           — zones (to locate load balancers)
//   GET /zones/{zone}/load_balancers                        — load balancers + steering policy
import { CloudflareError } from './errors.js';
import type {
  CloudflareClient, CloudflareHealthCheck, CloudflareLoadBalancer, CloudflareObserved, CloudflareObservedBucket,
  CloudflareOrigin, CloudflarePool, CloudflareSnapshot, CloudflareSteeredPool, CloudflareSummary,
} from './types.js';

export interface HttpCloudflareClientOptions {
  apiBase: string;
  token: string;
  accountId: string;
  /** Zone names to read load balancers from; empty → all non-reverse-DNS zones. */
  lbZones: string[];
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const FETCH_CONCURRENCY = 6;

/** Run `fn` over `items` with bounded concurrency; a failed item → null. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

export class HttpCloudflareReadClient implements CloudflareClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: HttpCloudflareClientOptions) {
    if (!/^https?:\/\//i.test(opts.apiBase)) throw new Error('HttpCloudflareReadClient: apiBase must be an http(s) URL.');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  async getSnapshot(correlationId?: string): Promise<CloudflareSnapshot> {
    const warnings: string[] = [];
    // 1. Health-check monitors (best-effort) + pools (account-level).
    const monitors = await this.fetchMonitors(correlationId);
    const rawPools = await this.getPaged(`/accounts/${enc(this.opts.accountId)}/load_balancers/pools`, correlationId);
    const pools = rawPools.map((p) => buildPool(p, monitors));
    const poolNameById = new Map(pools.map((p) => [p.id, p.name]));

    // 2. Zones that carry load balancers (configured, or auto-discovered).
    const zones = await this.resolveLbZones(correlationId);
    // 3. Per zone: load balancers (steering policy + weights) + observed traffic (LB analytics).
    const perZone = await mapLimit(zones, FETCH_CONCURRENCY, async (z) => {
      const raw = await this.getPaged(`/zones/${enc(z.id)}/load_balancers`, correlationId);
      const observed = await this.fetchObserved(z.id, correlationId);
      return raw.map((lb) => buildLoadBalancer(lb, z.name, poolNameById, observed));
    });
    const loadBalancers = perZone.flatMap((r) => r ?? []).sort((a, b) => a.name.localeCompare(b.name));
    if (perZone.some((r) => r === null)) warnings.push('Some zones could not be read for load balancers.');

    return {
      source: 'cloudflare',
      capturedAt: new Date(this.now()).toISOString(),
      loadBalancers,
      pools: pools.sort((a, b) => a.name.localeCompare(b.name)),
      summary: summarise(pools, loadBalancers),
      provenance: {
        source: 'cloudflare', synthetic: false, readOnly: true, informationalOnly: true,
        notice: 'Cloudflare Load Balancing is read-only and informational. RADAR issues no Cloudflare writes.',
        retrievedAt: new Date(this.now()).toISOString(),
      },
      warnings,
    };
  }

  /** Zones whose load balancers we read: the configured names, else all non-reverse-DNS zones. */
  private async resolveLbZones(correlationId?: string): Promise<{ id: string; name: string }[]> {
    const all = (await this.getPaged('/zones?per_page=50', correlationId)).map((z) => ({ id: String((z as { id: unknown }).id), name: String((z as { name: unknown }).name) }));
    if (this.opts.lbZones.length > 0) {
      const want = new Set(this.opts.lbZones.map((n) => n.toLowerCase()));
      return all.filter((z) => want.has(z.name.toLowerCase()));
    }
    return all.filter((z) => !/\.arpa$/i.test(z.name)); // reverse-DNS zones never carry LBs
  }

  // ---- Transport ----------------------------------------------------------------------------

  /** GET a paginated Cloudflare list endpoint → the concatenated `result` array. */
  private async getPaged(path: string, correlationId?: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const sep = path.includes('?') ? '&' : '?';
    let page = 1;
    for (;;) {
      const body = await this.getJson(`${path}${sep}page=${page}`, correlationId);
      if (!isObj(body) || body.success !== true) throw new CloudflareError('CLOUDFLARE_REQUEST_FAILED', 'Cloudflare API returned success:false.', { correlationId });
      const result = Array.isArray(body.result) ? (body.result as Record<string, unknown>[]) : [];
      out.push(...result.filter(isObj));
      const info = isObj(body.result_info) ? body.result_info : undefined;
      const totalPages = info && typeof info.total_pages === 'number' ? info.total_pages : 1;
      if (page >= totalPages || result.length === 0) break;
      page += 1;
    }
    return out;
  }

  /** monitorId → health-check spec (best-effort; empty on failure). */
  private async fetchMonitors(correlationId?: string): Promise<Map<string, CloudflareHealthCheck>> {
    const out = new Map<string, CloudflareHealthCheck>();
    try {
      const raw = await this.getPaged(`/accounts/${enc(this.opts.accountId)}/load_balancers/monitors`, correlationId);
      for (const m of raw) {
        const id = str(m.id);
        if (!id) continue;
        out.set(id, {
          type: String(m.type ?? ''), method: str(m.method), path: str(m.path),
          expectedCodes: str(m.expected_codes), expectedBody: str(m.expected_body),
          intervalSeconds: numN(m.interval), timeoutSeconds: numN(m.timeout), retries: numN(m.retries),
        });
      }
    } catch (err) {
      this.opts.logger?.warn({ code: err instanceof CloudflareError ? err.code : 'error' }, 'cloudflare: monitors fetch failed');
    }
    return out;
  }

  /** Observed traffic per load balancer (name → observed) from LB analytics over a recent window.
   *  Best-effort: analytics being unavailable never fails the snapshot (LBs just have observed=null). */
  private async fetchObserved(zoneId: string, correlationId?: string): Promise<Map<string, CloudflareObserved>> {
    const out = new Map<string, CloudflareObserved>();
    const windowHours = 1;
    const end = new Date(this.now()).toISOString();
    const start = new Date(this.now() - windowHours * 3_600_000).toISOString();
    const query =
      'query($z:String!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){loadBalancingRequestsAdaptiveGroups' +
      '(limit:500,filter:{datetime_geq:$s,datetime_leq:$e},orderBy:[count_DESC])' +
      '{count dimensions{lbName selectedPoolName region coloCode}}}}}';
    let groups: Array<{ count?: unknown; dimensions?: Record<string, unknown> }> = [];
    try {
      const data = await this.graphql(query, { z: zoneId, s: start, e: end }, correlationId);
      const zones = isObj(data) && isObj(data.viewer) && Array.isArray(data.viewer.zones) ? data.viewer.zones : [];
      const first = zones[0];
      if (isObj(first) && Array.isArray(first.loadBalancingRequestsAdaptiveGroups)) groups = first.loadBalancingRequestsAdaptiveGroups as typeof groups;
    } catch {
      return out; // analytics is best-effort
    }
    const agg = new Map<string, { total: number; pool: Map<string, number>; region: Map<string, number>; colo: Map<string, number> }>();
    for (const g of groups) {
      const dm = g.dimensions ?? {};
      const lb = String(dm.lbName ?? '');
      if (!lb) continue;
      const count = typeof g.count === 'number' ? g.count : 0;
      let a = agg.get(lb);
      if (!a) { a = { total: 0, pool: new Map(), region: new Map(), colo: new Map() }; agg.set(lb, a); }
      a.total += count;
      addTo(a.pool, String(dm.selectedPoolName || '—'), count);
      addTo(a.region, String(dm.region || '—'), count);
      addTo(a.colo, String(dm.coloCode || '—'), count);
    }
    for (const [lb, a] of agg) {
      out.set(lb, { windowHours, totalRequests: a.total, byPool: buckets(a.pool, a.total), byRegion: buckets(a.region, a.total), byColo: buckets(a.colo, a.total) });
    }
    return out;
  }

  /** Read-only GraphQL analytics query (POST is the transport; the query is fixed, no mutation,
   *  no user input). Returns the `data` object, or throws on transport/GraphQL error. */
  private async graphql(query: string, variables: Record<string, unknown>, correlationId?: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.opts.apiBase}/graphql`, {
      method: 'POST',
      headers: { ...this.headers(correlationId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw CloudflareError.fromStatus(res.status, correlationId);
    const body = await res.json();
    if (isObj(body) && Array.isArray(body.errors) && body.errors.length > 0) throw new CloudflareError('CLOUDFLARE_REQUEST_FAILED', 'Cloudflare GraphQL returned errors.', { correlationId });
    return isObj(body) ? body.data : undefined;
  }

  private headers(correlationId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.opts.token}`, // redacted from all logs
      'User-Agent': 'radar/1.0',
    };
    if (correlationId) h['X-Correlation-ID'] = correlationId;
    return h;
  }

  private async getJson(path: string, correlationId?: string): Promise<unknown> {
    const res = await this.request(path, correlationId);
    try {
      return await res.json();
    } catch (cause) {
      throw new CloudflareError('CLOUDFLARE_INVALID_RESPONSE', undefined, { correlationId, cause });
    }
  }

  /** GET with bounded exponential backoff + full jitter for transient failures only. */
  private async request(path: string, correlationId?: string): Promise<Response> {
    const url = `${this.opts.apiBase}${path}`;
    let lastTransient: CloudflareError | undefined;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt));
      try {
        const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers(correlationId), signal: AbortSignal.timeout(this.opts.timeoutMs) });
        if (!res.ok) {
          const err = CloudflareError.fromStatus(res.status, correlationId);
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        return res;
      } catch (err) {
        if (err instanceof CloudflareError) {
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        lastTransient = new CloudflareError(isTimeout ? 'CLOUDFLARE_UPSTREAM_TIMEOUT' : 'CLOUDFLARE_UPSTREAM_UNAVAILABLE', undefined, { correlationId, transient: true, cause: err });
      }
    }
    throw lastTransient ?? new CloudflareError('CLOUDFLARE_UPSTREAM_UNAVAILABLE', undefined, { correlationId });
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(2000, 200 * 2 ** (attempt - 1));
    return Math.round(base * this.random());
  }
}

// ---- Wire → canonical mappers (pure) --------------------------------------------------------

const enc = encodeURIComponent;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const boolN = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const numN = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const addTo = (m: Map<string, number>, k: string, n: number): void => { m.set(k, (m.get(k) ?? 0) + n); };
const buckets = (m: Map<string, number>, total: number, top = 8): CloudflareObservedBucket[] =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, requests]) => ({ key, requests, sharePercent: total > 0 ? Math.round((requests / total) * 1000) / 10 : 0 }));

function buildPool(p: Record<string, unknown>, monitors: Map<string, CloudflareHealthCheck>): CloudflarePool {
  const origins: CloudflareOrigin[] = (Array.isArray(p.origins) ? p.origins : []).filter(isObj).map((o) => ({
    name: String(o.name ?? ''),
    address: String(o.address ?? ''),
    weight: typeof o.weight === 'number' ? o.weight : 1,
    enabled: o.enabled !== false,
    healthy: boolN(o.healthy),
    failureReason: str(o.failure_reason),
  }));
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    description: str(p.description),
    enabled: p.enabled !== false,
    healthy: boolN(p.healthy),
    monitorId: str(p.monitor),
    healthCheck: str(p.monitor) ? monitors.get(str(p.monitor)!) ?? null : null,
    minimumOrigins: typeof p.minimum_origins === 'number' ? p.minimum_origins : null,
    origins,
    healthyOrigins: origins.filter((o) => o.enabled && o.healthy === true).length,
    totalOrigins: origins.length,
  };
}

function buildLoadBalancer(lb: Record<string, unknown>, zoneName: string | null, poolNames: Map<string, string>, observed: Map<string, CloudflareObserved>): CloudflareLoadBalancer {
  const weights = isObj(lb.random_steering) && isObj(lb.random_steering.pool_weights) ? lb.random_steering.pool_weights : {};
  const resolve = (id: unknown): CloudflareSteeredPool => ({ poolId: String(id), poolName: poolNames.get(String(id)) ?? null, weight: numN((weights as Record<string, unknown>)[String(id)]) });
  const resolveList = (v: unknown): CloudflareSteeredPool[] => (Array.isArray(v) ? v.map(resolve) : []);
  const resolveMap = (v: unknown): Record<string, CloudflareSteeredPool[]> => {
    const out: Record<string, CloudflareSteeredPool[]> = {};
    if (isObj(v)) for (const [k, val] of Object.entries(v)) out[k] = resolveList(val);
    return out;
  };
  const name = String(lb.name ?? '');
  return {
    id: String(lb.id ?? ''),
    name,
    zoneName: zoneName ?? str(lb.zone_name),
    enabled: lb.enabled !== false,
    proxied: lb.proxied === true,
    steeringPolicy: str(lb.steering_policy) ?? 'off',
    defaultPools: resolveList(lb.default_pools),
    fallbackPool: lb.fallback_pool ? resolve(lb.fallback_pool) : null,
    regionPools: resolveMap(lb.region_pools),
    popPools: resolveMap(lb.pop_pools),
    sessionAffinity: str(lb.session_affinity),
    locationStrategy: isObj(lb.location_strategy) ? str(lb.location_strategy.mode) : null,
    observed: observed.get(name) ?? null,
  };
}

export function summarise(pools: CloudflarePool[], loadBalancers: CloudflareLoadBalancer[]): CloudflareSummary {
  const origins = pools.flatMap((p) => p.origins);
  return {
    loadBalancerCount: loadBalancers.length,
    poolCount: pools.length,
    originCount: origins.length,
    unhealthyPools: pools.filter((p) => p.enabled && p.healthy === false).length,
    unhealthyOrigins: origins.filter((o) => o.enabled && o.healthy === false).length,
  };
}

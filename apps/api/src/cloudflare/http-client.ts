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
  CloudflareClient, CloudflareLoadBalancer, CloudflareOrigin, CloudflarePool, CloudflareSnapshot,
  CloudflareSteeredPool, CloudflareSummary,
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
    // 1. Pools (account-level) — the origin sets Cloudflare can steer to.
    const rawPools = await this.getPaged(`/accounts/${enc(this.opts.accountId)}/load_balancers/pools`, correlationId);
    const pools = rawPools.map((p) => buildPool(p));
    const poolNameById = new Map(pools.map((p) => [p.id, p.name]));

    // 2. Zones that carry load balancers (configured, or auto-discovered).
    const zones = await this.resolveLbZones(correlationId);
    // 3. Load balancers per zone (steering policy + pool references, resolved to names).
    const perZone = await mapLimit(zones, FETCH_CONCURRENCY, async (z) => {
      const raw = await this.getPaged(`/zones/${enc(z.id)}/load_balancers`, correlationId);
      return raw.map((lb) => buildLoadBalancer(lb, z.name, poolNameById));
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

function buildPool(p: Record<string, unknown>): CloudflarePool {
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
    minimumOrigins: typeof p.minimum_origins === 'number' ? p.minimum_origins : null,
    origins,
    healthyOrigins: origins.filter((o) => o.enabled && o.healthy === true).length,
    totalOrigins: origins.length,
  };
}

function buildLoadBalancer(lb: Record<string, unknown>, zoneName: string | null, poolNames: Map<string, string>): CloudflareLoadBalancer {
  const resolve = (id: unknown): CloudflareSteeredPool => ({ poolId: String(id), poolName: poolNames.get(String(id)) ?? null });
  const resolveList = (v: unknown): CloudflareSteeredPool[] => (Array.isArray(v) ? v.map(resolve) : []);
  const resolveMap = (v: unknown): Record<string, CloudflareSteeredPool[]> => {
    const out: Record<string, CloudflareSteeredPool[]> = {};
    if (isObj(v)) for (const [k, val] of Object.entries(v)) out[k] = resolveList(val);
    return out;
  };
  return {
    id: String(lb.id ?? ''),
    name: String(lb.name ?? ''),
    zoneName: zoneName ?? str(lb.zone_name),
    enabled: lb.enabled !== false,
    proxied: lb.proxied === true,
    steeringPolicy: str(lb.steering_policy) ?? 'off',
    defaultPools: resolveList(lb.default_pools),
    fallbackPool: lb.fallback_pool ? resolve(lb.fallback_pool) : null,
    regionPools: resolveMap(lb.region_pools),
    popPools: resolveMap(lb.pop_pools),
    sessionAffinity: str(lb.session_affinity),
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

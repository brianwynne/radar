// Live, READ-ONLY Fastly CDN observability client. GET-only over HTTPS with a `Fastly-Key` token
// that is never logged, an explicit timeout, and bounded retry-with-jitter for transient failures.
// There is NO method that issues a non-GET request. Fastly wire shapes are mapped to RADAR's
// canonical model here and never escape this module.
//
// APIs used (all read; require a token with the `global:read` scope):
//   GET /service                                             — services (id, name, version)
//   GET /stats/service/{id}?from&to&by=minute                — per-service time-series delivery stats
import { FastlyError } from './errors.js';
import type { FastlyClient, FastlyService, FastlyServiceStats, FastlySnapshot, FastlySummary } from './types.js';

export interface HttpFastlyClientOptions {
  apiBase: string;
  token: string;
  /** Service ids to observe; empty → all services on the account. */
  serviceIds: string[];
  windowMinutes: number;
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

export class HttpFastlyReadClient implements FastlyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: HttpFastlyClientOptions) {
    if (!/^https?:\/\//i.test(opts.apiBase)) throw new Error('HttpFastlyReadClient: apiBase must be an http(s) URL.');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  async getSnapshot(correlationId?: string): Promise<FastlySnapshot> {
    const warnings: string[] = [];
    const windowSeconds = this.opts.windowMinutes * 60;
    const toSec = Math.floor(this.now() / 1000);
    const fromSec = toSec - windowSeconds;

    // 1. Resolve the services to observe (names come from the account service list).
    const services = await this.resolveServices(warnings, correlationId);

    // 2. Per service: aggregate the per-minute stats buckets over the window. A per-service
    //    failure is a warning; the service is still listed with zeroed/absent stats.
    const stats = await mapLimit(services, FETCH_CONCURRENCY, async (svc) => {
      try {
        const buckets = await this.fetchServiceStats(svc.id, fromSec, toSec, correlationId);
        return aggregate(svc, windowSeconds, buckets);
      } catch (err) {
        warnings.push(`Stats unavailable for service ${svc.name} (${svc.id}).`);
        this.opts.logger?.warn({ code: err instanceof FastlyError ? err.code : 'error', serviceId: svc.id }, 'fastly: service stats fetch failed');
        return aggregate(svc, windowSeconds, []);
      }
    });
    const services_ = stats.filter((s): s is FastlyServiceStats => s !== null).sort((a, b) => b.requestsPerSecond - a.requestsPerSecond);

    const at = new Date(this.now()).toISOString();
    return {
      source: 'fastly',
      capturedAt: at,
      services: services_,
      summary: summarise(services_),
      provenance: {
        source: 'fastly', synthetic: false, readOnly: true, informationalOnly: true,
        notice: 'Fastly CDN telemetry is read-only and informational. RADAR issues no Fastly writes.',
        retrievedAt: at,
      },
      warnings,
    };
  }

  /** Services to observe: the configured ids (names resolved from the account list when possible),
   *  else every service on the account. */
  private async resolveServices(warnings: string[], correlationId?: string): Promise<FastlyService[]> {
    let listed: FastlyService[] = [];
    try {
      listed = await this.fetchServices(correlationId);
    } catch (err) {
      if (this.opts.serviceIds.length === 0) throw err; // no fallback list — surface the failure
      warnings.push('Could not list Fastly services; using the configured service ids.');
      this.opts.logger?.warn({ code: err instanceof FastlyError ? err.code : 'error' }, 'fastly: service list failed');
    }
    if (this.opts.serviceIds.length === 0) return listed;
    const byId = new Map(listed.map((s) => [s.id, s]));
    return this.opts.serviceIds.map((id) => byId.get(id) ?? { id, name: id, version: null });
  }

  private async fetchServices(correlationId?: string): Promise<FastlyService[]> {
    const body = await this.getJson('/service', correlationId);
    const arr = Array.isArray(body) ? body : [];
    return arr.filter(isObj).map((s) => ({
      id: String(s.id ?? ''),
      name: typeof s.name === 'string' && s.name.length > 0 ? s.name : String(s.id ?? ''),
      version: activeVersion(s),
    })).filter((s) => s.id.length > 0);
  }

  private async fetchServiceStats(serviceId: string, fromSec: number, toSec: number, correlationId?: string): Promise<Record<string, unknown>[]> {
    const path = `/stats/service/${enc(serviceId)}?from=${fromSec}&to=${toSec}&by=minute`;
    const body = await this.getJson(path, correlationId);
    if (!isObj(body)) throw new FastlyError('FASTLY_INVALID_RESPONSE', 'Fastly stats response was not an object.', { correlationId });
    return Array.isArray(body.data) ? (body.data as unknown[]).filter(isObj) : [];
  }

  // ---- Transport ----------------------------------------------------------------------------

  private headers(correlationId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'Fastly-Key': this.opts.token, // redacted from all logs
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
      throw new FastlyError('FASTLY_INVALID_RESPONSE', undefined, { correlationId, cause });
    }
  }

  /** GET with bounded exponential backoff + full jitter for transient failures only. */
  private async request(path: string, correlationId?: string): Promise<Response> {
    const url = `${this.opts.apiBase}${path}`;
    let lastTransient: FastlyError | undefined;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt));
      try {
        const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers(correlationId), signal: AbortSignal.timeout(this.opts.timeoutMs) });
        if (!res.ok) {
          const err = FastlyError.fromStatus(res.status, correlationId);
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        return res;
      } catch (err) {
        if (err instanceof FastlyError) {
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        lastTransient = new FastlyError(isTimeout ? 'FASTLY_UPSTREAM_TIMEOUT' : 'FASTLY_UPSTREAM_UNAVAILABLE', undefined, { correlationId, transient: true, cause: err });
      }
    }
    throw lastTransient ?? new FastlyError('FASTLY_UPSTREAM_UNAVAILABLE', undefined, { correlationId });
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(2000, 200 * 2 ** (attempt - 1));
    return Math.round(base * this.random());
  }
}

// ---- Wire → canonical mappers (pure) --------------------------------------------------------

const enc = encodeURIComponent;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pct1 = (n: number): number => Math.round(n * 10) / 10;

/** Fastly `/service` entries carry a `versions[]` array; the active one is the deployed config. */
function activeVersion(s: Record<string, unknown>): number | null {
  if (typeof s.version === 'number') return s.version;
  const versions = Array.isArray(s.versions) ? s.versions : [];
  const active = versions.filter(isObj).find((v) => v.active === true);
  if (active && typeof active.number === 'number') return active.number;
  return null;
}

/** Reduce the per-minute stats buckets to one canonical FastlyServiceStats representing the MOST
 *  RECENT FINALISED MINUTE.
 *
 *  Fastly's `by=minute` stats lag ~3 minutes — the current minute is never returned until finalised.
 *  Averaging the whole requested window smears a 10-minute trailing mean over a signal that may have
 *  just stepped (a service whose traffic just dropped keeps reading high for many minutes). Instead
 *  we surface the freshest complete minute — the closest-to-now coherent reading Fastly offers — so
 *  the figure tracks reality (and the real-time stream) as tightly as the ~3-min lag allows.
 *  `windowSeconds` = 60. A service with no buckets reads as absent/zero, never fabricated. */
export function aggregate(svc: FastlyService, _windowSeconds: number, buckets: Record<string, unknown>[]): FastlyServiceStats {
  const SECONDS = 60;
  const b = latestBucket(buckets) ?? {};
  const requests = num(b.requests);
  const hits = num(b.hits);
  const miss = num(b.miss);
  const bandwidth = num(b.bandwidth);
  const originFetches = num(b.origin_fetches);
  const s2 = num(b.status_2xx), s3 = num(b.status_3xx), s4 = num(b.status_4xx), s5 = num(b.status_5xx);
  const cacheable = hits + miss;
  return {
    serviceId: svc.id,
    serviceName: svc.name,
    windowSeconds: SECONDS,
    requests,
    requestsPerSecond: Math.round((requests / SECONDS) * 10) / 10,
    hits,
    miss,
    hitRatioPercent: cacheable > 0 ? pct1((hits / cacheable) * 100) : null,
    bandwidthBytes: bandwidth,
    bandwidthBps: Math.round((bandwidth * 8) / SECONDS),
    originFetches,
    originOffloadPercent: requests > 0 ? pct1(Math.min(100, Math.max(0, (1 - originFetches / requests) * 100))) : null,
    status2xx: s2,
    status3xx: s3,
    status4xx: s4,
    status5xx: s5,
    errorRatePercent: requests > 0 ? pct1((s5 / requests) * 100) : null,
  };
}

/** The most recent finalised bucket, by `start_time` (falls back to array order — Fastly returns
 *  buckets oldest-first — when the field is absent). */
function latestBucket(buckets: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (buckets.length === 0) return undefined;
  const timed = buckets.filter((b) => typeof b.start_time === 'number');
  if (timed.length > 0) return timed.reduce((a, b) => (num(b.start_time) >= num(a.start_time) ? b : a));
  return buckets[buckets.length - 1];
}

export function summarise(services: FastlyServiceStats[]): FastlySummary {
  const totalRps = services.reduce((a, s) => a + s.requestsPerSecond, 0);
  const totalBps = services.reduce((a, s) => a + s.bandwidthBps, 0);
  // Request-weighted average hit ratio (only services that reported cacheable traffic).
  let wSum = 0, wReq = 0;
  for (const s of services) {
    if (s.hitRatioPercent !== null) {
      const w = s.hits + s.miss;
      wSum += s.hitRatioPercent * w;
      wReq += w;
    }
  }
  return {
    serviceCount: services.length,
    totalRequestsPerSecond: Math.round(totalRps * 10) / 10,
    totalBandwidthBps: totalBps,
    avgHitRatioPercent: wReq > 0 ? pct1(wSum / wReq) : null,
  };
}

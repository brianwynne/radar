// RIPEstat data-API client (read-only public API). Explicit timeouts, bounded retries with
// backoff, per-(endpoint,resource) caching (1–5 min), response validation, structured error
// classification and source timestamps. Never scrapes web pages; always the JSON data API with a
// `sourceapp` tag. Injectable fetch + clock for tests. Raw RIPE shapes never leave this module —
// the adapter turns them into RADAR's normalised model.

export type RipeErrorCode = 'RIPE_TIMEOUT' | 'RIPE_HTTP' | 'RIPE_NETWORK' | 'RIPE_PARSE';

export class RipeError extends Error {
  constructor(public readonly code: RipeErrorCode, message: string) {
    super(message);
    this.name = 'RipeError';
  }
}

// ---- Typed raw responses (only the fields RADAR consumes) -----------------------------------

export interface RoutingStatusData {
  first_seen?: { prefix?: string; origin?: string; time?: string } | null;
  last_seen?: { prefix?: string; origin?: string; time?: string } | null;
  visibility?: { v4?: { ris_peers_seeing?: number; total_ris_peers?: number }; v6?: { ris_peers_seeing?: number; total_ris_peers?: number } };
  origins?: { origin?: number; route_objects?: string[] }[];
  less_specifics?: Array<{ prefix?: string; origin?: string } | string>;
  more_specifics?: Array<{ prefix?: string; origin?: string } | string>;
  resource?: string;
  query_time?: string;
}

export interface RpkiValidationData {
  resource?: string;
  prefix?: string;
  status?: string; // valid | invalid | unknown
  validator?: string;
  validating_roas?: { origin?: string; prefix?: string; validity?: string; max_length?: number }[];
}

export interface LookingGlassPeer {
  asn_origin?: string;
  as_path?: string; // space-separated
  prefix?: string;
  peer?: string;
  next_hop?: string;
  last_updated?: string;
  latest_time?: string;
}
export interface LookingGlassRrc {
  rrc?: string;
  location?: string;
  peers?: LookingGlassPeer[];
}
export interface LookingGlassData {
  rrcs?: LookingGlassRrc[];
  query_time?: string;
  latest_time?: string;
}

export interface VisibilityProbe {
  name?: string;
  city?: string;
  country?: string;
  ipv4_peer_count?: number;
  ipv6_peer_count?: number;
}
export interface VisibilityEntry {
  probe?: VisibilityProbe;
  ipv4_full_table_peers_not_seeing?: string[];
  ipv6_full_table_peers_not_seeing?: string[];
  ipv4_full_table_peer_count?: number;
  ipv6_full_table_peer_count?: number;
}
export interface VisibilityData {
  visibilities?: VisibilityEntry[];
  resource?: string;
  query_time?: string;
  latest_time?: string;
}

export interface Fetched<T> {
  data: T;
  fetchedAt: string; // ISO — when RADAR fetched
}

export interface RipestatClient {
  routingStatus(resource: string): Promise<Fetched<RoutingStatusData>>;
  rpkiValidation(asn: number, prefix: string): Promise<Fetched<RpkiValidationData>>;
  lookingGlass(prefix: string): Promise<Fetched<LookingGlassData>>;
  visibility(prefix: string): Promise<Fetched<VisibilityData>>;
}

export interface RipestatClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
  sourceapp?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  now?: () => number;
  logger?: { warn(obj: unknown, msg?: string): void };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createRipestatClient(opts: RipestatClientOptions = {}): RipestatClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? 'https://stat.ripe.net/data').replace(/\/$/, '');
  const userAgent = opts.userAgent ?? 'RADAR/bgp-intelligence';
  const sourceapp = opts.sourceapp ?? 'radar';
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 2;
  const cacheTtlMs = opts.cacheTtlMs ?? 2 * 60 * 1000; // 2 min — RIPEstat caching guidance
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; value: Fetched<unknown> }>();

  async function getJson<T>(path: string, cacheKey: string): Promise<Fetched<T>> {
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < cacheTtlMs) return cached.value as Fetched<T>;

    let lastErr: RipeError = new RipeError('RIPE_NETWORK', 'no attempt');
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}sourceapp=${encodeURIComponent(sourceapp)}`;
        const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: controller.signal });
        if (!res.ok) throw new RipeError('RIPE_HTTP', `RIPEstat returned HTTP ${res.status}.`);
        let body: { data?: T };
        try {
          body = (await res.json()) as { data?: T };
        } catch {
          throw new RipeError('RIPE_PARSE', 'RIPEstat response was not valid JSON.');
        }
        if (!body || typeof body !== 'object' || body.data === undefined) throw new RipeError('RIPE_PARSE', 'RIPEstat response missing the data envelope.');
        const value: Fetched<T> = { data: body.data, fetchedAt: new Date(now()).toISOString() };
        cache.set(cacheKey, { at: now(), value });
        return value;
      } catch (err) {
        lastErr = err instanceof RipeError ? err : (err as Error)?.name === 'AbortError' ? new RipeError('RIPE_TIMEOUT', `RIPEstat request timed out after ${timeoutMs}ms.`) : new RipeError('RIPE_NETWORK', err instanceof Error ? err.message : 'network error');
        // Retry only transient failures (timeout / network / 5xx-ish http); parse errors won't heal.
        if (lastErr.code === 'RIPE_PARSE' || attempt === retries) break;
        await sleep(200 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    opts.logger?.warn({ code: lastErr.code, path }, 'ripestat: request failed');
    throw lastErr;
  }

  return {
    routingStatus: (resource) => getJson<RoutingStatusData>(`/routing-status/data.json?resource=${encodeURIComponent(resource)}`, `rs:${resource}`),
    rpkiValidation: (asn, prefix) => getJson<RpkiValidationData>(`/rpki-validation/data.json?resource=AS${asn}&prefix=${encodeURIComponent(prefix)}`, `rpki:${asn}:${prefix}`),
    lookingGlass: (prefix) => getJson<LookingGlassData>(`/looking-glass/data.json?resource=${encodeURIComponent(prefix)}`, `lg:${prefix}`),
    visibility: (prefix) => getJson<VisibilityData>(`/visibility/data.json?resource=${encodeURIComponent(prefix)}`, `vis:${prefix}`),
  };
}

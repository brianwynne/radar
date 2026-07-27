// Provider-specific response-header adapters. Normalise Akamai and Fastly cache diagnostics into a
// common shape so the cross-CDN engine can reason about WHERE a response came from (edge cache,
// parent/shield cache, or the origin) and which origin served it. Header names for origin identity
// are configurable per deployment (the "internal origin-information header"). Pure string parsing.

export type CacheTier = 'hit' | 'miss' | 'unknown';
export type CdnKind = 'akamai' | 'fastly' | 'realta' | 'origin' | 'custom' | 'unknown';

export interface CdnObservation {
  cdn: CdnKind;
  /** Edge (nearest) cache result. */
  edge: CacheTier;
  /** Parent / shield cache result (the tier in front of origin). `unknown` when not reported. */
  parent: CacheTier;
  /** True when the response demonstrably came from origin (edge AND parent both missed). */
  fetchedFromOrigin: boolean;
  /** Origin/server identity, from a configured identity header when present. */
  originIdentity: string | null;
  /** CDN node/POP that served the response, where reported. */
  servedBy: string | null;
  /** Object age in seconds from the `Age` header, when present. */
  age: number | null;
}

export interface HeaderAdapterConfig {
  /** Response header names that carry the internal origin identity (first match wins). */
  originIdentityHeaders?: string[];
}

const DEFAULT_ORIGIN_HEADERS = ['x-rte-origin', 'x-origin-name', 'x-origin', 'x-served-origin'];

/** Case-insensitive header lookup. */
const get = (h: Record<string, string>, name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
};

const tierOf = (value: string | undefined): CacheTier => {
  if (!value) return 'unknown';
  // CDN cache tokens embed the result in a larger word (e.g. "TCP_MISS", "TCP_HIT"), so match the
  // substring case-insensitively rather than a whole word.
  if (/hit/i.test(value)) return 'hit';
  if (/miss/i.test(value)) return 'miss';
  return 'unknown';
};

const originIdentity = (h: Record<string, string>, cfg?: HeaderAdapterConfig): string | null => {
  for (const name of cfg?.originIdentityHeaders ?? DEFAULT_ORIGIN_HEADERS) {
    const v = get(h, name);
    if (v) return v.trim();
  }
  return null;
};

const ageOf = (h: Record<string, string>): number | null => {
  const v = get(h, 'age');
  if (v == null) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
};

/** Akamai: X-Cache (edge) + X-Cache-Remote (parent), plus optional origin identity. */
export function parseAkamaiHeaders(h: Record<string, string>, cfg?: HeaderAdapterConfig): CdnObservation {
  const edge = tierOf(get(h, 'x-cache'));
  const parent = tierOf(get(h, 'x-cache-remote'));
  return {
    cdn: 'akamai', edge, parent,
    fetchedFromOrigin: edge === 'miss' && parent === 'miss',
    originIdentity: originIdentity(h, cfg),
    servedBy: get(h, 'x-cache-key') ?? get(h, 'x-true-cache-key') ?? null,
    age: ageOf(h),
  };
}

/** Fastly: X-Cache (comma-separated node results, edge first, shield next) + X-Served-By. */
export function parseFastlyHeaders(h: Record<string, string>, cfg?: HeaderAdapterConfig): CdnObservation {
  const xcache = get(h, 'x-cache');
  const parts = (xcache ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // Fastly lists results in delivery order; the LAST (closest to the client) is the edge, the first
  // is the tier nearest origin. With two nodes: [shield, edge].
  const edge = tierOf(parts.length ? parts[parts.length - 1] : xcache);
  const parent = parts.length > 1 ? tierOf(parts[0]) : 'unknown';
  const servedBy = get(h, 'x-served-by') ?? null;
  return {
    cdn: 'fastly', edge, parent,
    fetchedFromOrigin: edge === 'miss' && (parent === 'miss' || parts.length <= 1),
    originIdentity: originIdentity(h, cfg),
    servedBy: servedBy ? servedBy.split(',').map((s) => s.trim()).pop()! : null,
    age: ageOf(h),
  };
}

/** Generic origin/Réalta/custom: no CDN cache tiers; treat as served directly. */
export function parseGenericHeaders(kind: CdnKind, h: Record<string, string>, cfg?: HeaderAdapterConfig): CdnObservation {
  return { cdn: kind, edge: 'unknown', parent: 'unknown', fetchedFromOrigin: kind === 'origin', originIdentity: originIdentity(h, cfg), servedBy: get(h, 'server') ?? null, age: ageOf(h) };
}

export function parseCdnHeaders(kind: CdnKind, h: Record<string, string>, cfg?: HeaderAdapterConfig): CdnObservation {
  if (kind === 'akamai') return parseAkamaiHeaders(h, cfg);
  if (kind === 'fastly') return parseFastlyHeaders(h, cfg);
  return parseGenericHeaders(kind, h, cfg);
}

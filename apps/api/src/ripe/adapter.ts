// RIPE adapter — pure normalisation of the four RIPEstat responses into RADAR's RouteVisibility
// model, plus the operational assessment. Deterministic (injected clock). Missing/failed endpoints
// degrade the record to unknown/partial and are NEVER read as a withdrawal: only routing-status
// that SUCCEEDS and reports zero peers/origins corroborates a withdrawal (and a live covering
// aggregate downgrades that to a traffic-engineering degradation, not an outage).
import type {
  Fetched, LookingGlassData, RipestatClient, RoutingStatusData, RpkiValidationData, VisibilityData,
} from './client.js';
import type {
  AddressFamily, CloudVisionCorrelation, CollectorVisibility, RepresentativePath, Freshness,
  RouteHealth, RouteVisibility, RouteVisibilityCounts, RouteVisibilitySnapshot, RipeSourceHealth, RpkiState,
} from './types.js';

export interface AssessConfig {
  /** Visibility ≥ this % (of RIS collector peers) is strong. */
  visibilityHealthyPercent: number;
  /** Visibility < this % is materially reduced. */
  visibilityDegradedPercent: number;
  /** Source observation older than this is stale. */
  maxAgeSeconds: number;
}

export const DEFAULT_ASSESS: AssessConfig = { visibilityHealthyPercent: 80, visibilityDegradedPercent: 50, maxAgeSeconds: 3 * 60 * 60 };

/** Per-prefix inputs — any endpoint may be absent (it failed); `errors` records why. */
export interface RipeInputs {
  routingStatus?: Fetched<RoutingStatusData>;
  rpki?: Fetched<RpkiValidationData>;
  lookingGlass?: Fetched<LookingGlassData>;
  visibility?: Fetched<VisibilityData>;
  errors?: Partial<Record<'routingStatus' | 'rpki' | 'lookingGlass' | 'visibility', string>>;
}

const familyOf = (prefix: string): AddressFamily => (prefix.includes(':') ? 'ipv6' : 'ipv4');
const prefixOf = (x: { prefix?: string } | string | undefined): string | null =>
  x == null ? null : typeof x === 'string' ? x : typeof x.prefix === 'string' ? x.prefix : null;

const NOT_YET: CloudVisionCorrelation = {
  localRoutePresent: 'unknown', locallyOriginated: 'unknown', advertisedToNeighbours: 'unknown',
  note: 'CloudVision correlation not yet available — RADAR never infers local advertisement from RIPE observations.',
};

function rpkiStateOf(rpki: RpkiValidationData | undefined, checked: boolean): { state: RpkiState; maxLength: number | null } {
  if (!checked || !rpki) return { state: 'not-checked', maxLength: null };
  const s = (rpki.status ?? '').toLowerCase();
  const maxLength = typeof rpki.validating_roas?.[0]?.max_length === 'number' ? rpki.validating_roas[0].max_length! : null;
  if (s === 'valid') return { state: 'valid', maxLength };
  if (s === 'invalid') return { state: 'invalid', maxLength };
  return { state: 'not-found', maxLength }; // "unknown" from RIPE = no covering ROA = not-found (unprotected)
}

/** Group looking-glass observations by identical AS path; return top paths + the upstreams (the ASN
 *  immediately before the expected origin) and the collector count. */
function paths(lg: LookingGlassData | undefined, expectedOrigin: number): { representative: RepresentativePath[]; upstreams: number[]; collectorCount: number | null } {
  if (!lg?.rrcs) return { representative: [], upstreams: [], collectorCount: null };
  const byPath = new Map<string, RepresentativePath>();
  const upstreams = new Set<number>();
  let collectorsSeeing = 0;
  for (const rrc of lg.rrcs) {
    let rrcSees = false;
    for (const peer of rrc.peers ?? []) {
      const asPath = (peer.as_path ?? '').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (asPath.length === 0) continue;
      rrcSees = true;
      const key = asPath.join(' ');
      const existing = byPath.get(key);
      if (existing) existing.count += 1;
      else byPath.set(key, { collector: rrc.rrc ?? '?', peerAsn: asPath[0] ?? null, asPath, count: 1 });
      const idx = asPath.lastIndexOf(expectedOrigin);
      if (idx > 0) upstreams.add(asPath[idx - 1]);
    }
    if (rrcSees) collectorsSeeing += 1;
  }
  const representative = [...byPath.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  return { representative, upstreams: [...upstreams].sort((a, b) => a - b), collectorCount: collectorsSeeing };
}

function collectorsOf(vis: VisibilityData | undefined, family: AddressFamily): CollectorVisibility[] {
  if (!vis?.visibilities) return [];
  return vis.visibilities.map((v) => {
    const total = (family === 'ipv4' ? v.probe?.ipv4_peer_count : v.probe?.ipv6_peer_count) ?? 0;
    const seeing = (family === 'ipv4' ? v.ipv4_full_table_peer_count : v.ipv6_full_table_peer_count) ?? 0;
    return { collector: v.probe?.name ?? '?', city: v.probe?.city ?? null, country: v.probe?.country ?? null, peersSeeing: seeing, peersTotal: total };
  });
}

/** Normalise one prefix. Pure. */
export function normalizePrefix(prefix: string, expectedOrigin: number, input: RipeInputs, cfg: AssessConfig, nowMs: number): RouteVisibility {
  const family = familyOf(prefix);
  const rs = input.routingStatus?.data;
  const rsOk = input.routingStatus !== undefined;
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(input.errors ?? {})) warnings.push(`${k}: ${v}`);

  const vis = family === 'ipv4' ? rs?.visibility?.v4 : rs?.visibility?.v6;
  const peersSeen = typeof vis?.ris_peers_seeing === 'number' ? vis.ris_peers_seeing : null;
  const peersEligible = typeof vis?.total_ris_peers === 'number' ? vis.total_ris_peers : null;
  const visibilityPercent = peersSeen !== null && peersEligible && peersEligible > 0 ? (peersSeen / peersEligible) * 100 : null;

  const observedOrigins = [...new Set((rs?.origins ?? []).map((o) => o.origin).filter((n): n is number => typeof n === 'number'))];
  const coveringPrefix = (rs?.less_specifics ?? []).map(prefixOf).find((p): p is string => p !== null) ?? null;
  const moreSpecifics = (rs?.more_specifics ?? []).map(prefixOf).filter((p): p is string => p !== null);

  const { representative, upstreams, collectorCount } = paths(input.lookingGlass?.data, expectedOrigin);
  const { state: rpkiState, maxLength } = rpkiStateOf(input.rpki?.data, input.rpki !== undefined);

  // RIPEstat routing-status is a periodic BATCH product — its query_time only advances every ~8h,
  // so "observed 8h ago" is normal, not a fault. Freshness must therefore reflect how long ago RADAR
  // last fetched (our monitoring recency), NOT RIPE's batch reference time. We keep query_time as an
  // informational "RIPE observed at" field; staleness = our fetch is older than maxAge (e.g. polling
  // stopped). This avoids alarming "treat with caution" on data we just pulled.
  const sourceObservedAt = rs?.query_time ?? rs?.last_seen?.time ?? null;
  const fetchedAt = input.routingStatus?.fetchedAt ?? new Date(nowMs).toISOString();
  const fetchAgeSeconds = Math.max(0, (nowMs - Date.parse(fetchedAt)) / 1000);
  const freshness: Freshness = !rsOk ? 'unknown' : fetchAgeSeconds > cfg.maxAgeSeconds ? 'stale' : 'fresh';

  const originAsExpected = observedOrigins.length > 0 && observedOrigins.every((o) => o === expectedOrigin);
  const unexpectedOrigin = observedOrigins.some((o) => o !== expectedOrigin);
  const partial = !rsOk || input.rpki === undefined;

  const record: RouteVisibility = {
    prefix, addressFamily: family, expectedOrigin, observedOrigins, originAsExpected, unexpectedOrigin,
    collectorPeersSeen: peersSeen, collectorPeersEligible: peersEligible, collectorVisibilityPercent: visibilityPercent,
    collectorCount, collectors: collectorsOf(input.visibility?.data, family),
    rpkiState, rpkiMaxLength: maxLength, representativePaths: representative, upstreams,
    coveringPrefix, moreSpecifics,
    firstSeen: rs?.first_seen?.time ?? null, lastSeen: rs?.last_seen?.time ?? null,
    sourceObservedAt, sourceFetchedAt: fetchedAt,
    freshness, health: 'unknown', reasons: [], cloudVision: NOT_YET, partial, warnings,
  };
  return assess(record, cfg);
}

/** RADAR's verdict. `record` is mutated (health/reasons) and returned. */
export function assess(r: RouteVisibility, cfg: AssessConfig): RouteVisibility {
  const reasons: string[] = [];
  const vp = r.collectorVisibilityPercent;
  const visText = vp === null ? 'unknown' : `${Math.round(vp)}%`;

  // Source unavailable/stale → UNKNOWN (monitoring degraded), never withdrawn.
  if (r.freshness === 'unknown') {
    r.health = 'unknown';
    r.reasons = ['RIPE routing-status is unavailable — monitoring is degraded (this is NOT a route withdrawal).'];
    return r;
  }
  if (r.freshness === 'stale') reasons.push('RIPE data is stale — treat with caution.');

  // Unexpected origin → CRITICAL (before visibility — an origin anomaly dominates).
  if (r.unexpectedOrigin) {
    const foreign = r.observedOrigins.filter((o) => o !== r.expectedOrigin).map((o) => `AS${o}`).join(', ');
    r.health = 'critical';
    r.reasons = [`Observed origin ${foreign} differs from the expected AS${r.expectedOrigin} — origin anomaly.`, ...reasons];
    return r;
  }
  // RPKI invalid → CRITICAL routing-integrity condition.
  if (r.rpkiState === 'invalid') {
    r.health = 'critical';
    r.reasons = [`RPKI INVALID for AS${r.expectedOrigin} — a routing-integrity condition.`, ...reasons];
    return r;
  }

  // No origin/peer sees the prefix, and routing-status corroborated it (freshness fresh/stale).
  const seesNothing = r.observedOrigins.length === 0 && (r.collectorPeersSeen === 0 || r.collectorPeersSeen === null);
  if (seesNothing) {
    if (r.coveringPrefix) {
      r.health = 'degraded';
      r.reasons = [`This prefix is not seen by RIPE RIS, but the covering ${r.coveringPrefix} remains visible — likely a traffic-engineering change, not a total outage.`, ...reasons];
    } else {
      r.health = 'withdrawn';
      r.reasons = [`No RIPE RIS peer sees this prefix and there is no visible covering aggregate — possible withdrawal.`, ...reasons];
    }
    return r;
  }

  // Expected origin present. Grade by visibility.
  if (r.rpkiState === 'not-found') reasons.push('RPKI not-found — the route is unprotected (no covering ROA), which is not the same as invalid.');
  if (vp !== null && vp < cfg.visibilityDegradedPercent) {
    r.health = 'degraded';
    reasons.unshift(`RIPE RIS collector visibility ${visText} is materially reduced.`);
  } else if (vp !== null && vp < cfg.visibilityHealthyPercent) {
    r.health = 'degraded';
    reasons.unshift(`RIPE RIS collector visibility ${visText} is below the healthy threshold.`);
  } else {
    r.health = 'healthy';
    reasons.unshift(`Origin AS${r.expectedOrigin} is expected${r.rpkiState === 'valid' ? ' and RPKI-valid' : ''}; seen at ${visText} RIPE RIS collector visibility.`);
  }
  r.reasons = reasons;
  return r;
}

const HEALTH_RANK: Record<RouteHealth, number> = { healthy: 0, unknown: 1, degraded: 2, withdrawn: 3, critical: 4 };

export function buildSnapshot(prefixes: RouteVisibility[], source: RipeSourceHealth, nowMs: number): RouteVisibilitySnapshot {
  const counts: RouteVisibilityCounts = { healthy: 0, degraded: 0, withdrawn: 0, critical: 0, unknown: 0, rpkiInvalid: 0, unexpectedOrigin: 0, total: prefixes.length };
  let overall: RouteHealth = 'healthy';
  for (const p of prefixes) {
    counts[p.health] += 1;
    if (p.rpkiState === 'invalid') counts.rpkiInvalid += 1;
    if (p.unexpectedOrigin) counts.unexpectedOrigin += 1;
    if (HEALTH_RANK[p.health] > HEALTH_RANK[overall]) overall = p.health;
  }
  if (prefixes.length === 0) overall = 'unknown';
  const warnings: string[] = [];
  if (source.status === 'unavailable') warnings.push('RIPE source unavailable — monitoring degraded; existing verdicts are not current.');
  return { capturedAt: new Date(nowMs).toISOString(), overall, counts, prefixes, source, warnings };
}

/** Fetch + normalise one prefix, tolerating per-endpoint failures (partial record, never fabricated). */
export async function fetchPrefix(client: RipestatClient, prefix: string, expectedOrigin: number, cfg: AssessConfig, nowMs: number): Promise<RouteVisibility> {
  const input: RipeInputs = { errors: {} };
  const settle = async <T>(label: keyof NonNullable<RipeInputs['errors']>, p: Promise<T>): Promise<T | undefined> => {
    try { return await p; } catch (e) { input.errors![label] = e instanceof Error ? e.message : 'failed'; return undefined; }
  };
  const [rs, rpki, lg, vis] = await Promise.all([
    settle('routingStatus', client.routingStatus(prefix)),
    settle('rpki', client.rpkiValidation(expectedOrigin, prefix)),
    settle('lookingGlass', client.lookingGlass(prefix)),
    settle('visibility', client.visibility(prefix)),
  ]);
  input.routingStatus = rs; input.rpki = rpki; input.lookingGlass = lg; input.visibility = vis;
  return normalizePrefix(prefix, expectedOrigin, input, cfg, nowMs);
}

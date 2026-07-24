// Redacted RIPE response fixtures + a mock client for dev/tests. Data is synthetic but schema-
// accurate (verified against the live RIPEstat data API). Peer IPs are RFC-doc/example addresses —
// no real RIS peer IPs. Scenarios cover healthy / degraded / withdrawn / unexpected-origin /
// rpki-invalid / source-unavailable, for both IPv4 and IPv6.
import type { LookingGlassData, RipestatClient, RoutingStatusData, RpkiValidationData, VisibilityData, Fetched } from './client.js';
import { RipeError } from './client.js';

export const RTE_ORIGIN = 41073;
export const MONITORED_PREFIXES: { prefix: string; expectedOrigin: number }[] = [
  { prefix: '89.207.57.0/24', expectedOrigin: RTE_ORIGIN },
  { prefix: '89.207.58.0/24', expectedOrigin: RTE_ORIGIN },
  { prefix: '89.207.56.0/21', expectedOrigin: RTE_ORIGIN },
  { prefix: '185.54.104.0/22', expectedOrigin: RTE_ORIGIN },
  { prefix: '2a00:1ed8::/29', expectedOrigin: RTE_ORIGIN },
];

const FT = '2026-07-24T08:00:00';
const isV6 = (p: string) => p.includes(':');

export function routingStatusData(prefix: string, o: { seen: number; total: number; origins?: number[]; covering?: string; moreSpecifics?: string[] }): RoutingStatusData {
  const v = { ris_peers_seeing: o.seen, total_ris_peers: o.total };
  return {
    first_seen: o.origins?.length ? { prefix, origin: String(o.origins[0]), time: '2006-09-09T00:00:00' } : null,
    last_seen: o.origins?.length ? { prefix, origin: String(o.origins[0]), time: FT } : null,
    visibility: isV6(prefix) ? { v4: { ris_peers_seeing: 0, total_ris_peers: 0 }, v6: v } : { v4: v, v6: { ris_peers_seeing: 0, total_ris_peers: 0 } },
    origins: (o.origins ?? []).map((origin) => ({ origin, route_objects: ['RIPE'] })),
    less_specifics: o.covering ? [{ prefix: o.covering, origin: String(RTE_ORIGIN) }] : [],
    more_specifics: (o.moreSpecifics ?? []).map((p) => ({ prefix: p, origin: String(RTE_ORIGIN) })),
    resource: prefix,
    query_time: FT,
  };
}

export function rpkiData(prefix: string, status: 'valid' | 'invalid' | 'unknown', maxLength = 24): RpkiValidationData {
  return { resource: String(RTE_ORIGIN), prefix, status, validator: 'routinator', validating_roas: status === 'unknown' ? [] : [{ origin: String(RTE_ORIGIN), prefix, validity: status, max_length: maxLength }] };
}

export function lookingGlassData(paths: number[][]): LookingGlassData {
  return {
    rrcs: paths.map((asPath, i) => ({
      rrc: `RRC0${i}`, location: 'Example City',
      peers: [{ asn_origin: String(asPath[asPath.length - 1]), as_path: asPath.join(' '), prefix: 'x', peer: '192.0.2.1', next_hop: '192.0.2.2', last_updated: FT, latest_time: FT }],
    })),
    query_time: FT, latest_time: FT,
  };
}

export function visibilityData(prefix: string, collectors: { name: string; city: string; country: string; total: number; seeing: number }[]): VisibilityData {
  const v6 = isV6(prefix);
  return {
    visibilities: collectors.map((c) => ({
      probe: { name: c.name, city: c.city, country: c.country, ipv4_peer_count: v6 ? 0 : c.total, ipv6_peer_count: v6 ? c.total : 0 },
      ipv4_full_table_peer_count: v6 ? 0 : c.seeing, ipv6_full_table_peer_count: v6 ? c.seeing : 0,
      ipv4_full_table_peers_not_seeing: [], ipv6_full_table_peers_not_seeing: [],
    })),
    resource: prefix, query_time: FT, latest_time: FT,
  };
}

export type RipeScenario = 'healthy' | 'degraded' | 'withdrawn_with_cover' | 'withdrawn' | 'unexpected_origin' | 'rpki_invalid' | 'unavailable';

/** Build the four responses for a scenario. `undefined` for an endpoint = it failed. */
export function scenarioResponses(prefix: string, scenario: RipeScenario): {
  rs?: RoutingStatusData; rpki?: RpkiValidationData; lg?: LookingGlassData; vis?: VisibilityData; fail?: boolean;
} {
  const upstream = isV6(prefix) ? 1299 : 174;
  const okVis = visibilityData(prefix, [{ name: 'RRC00', city: 'Amsterdam', country: 'Netherlands', total: 60, seeing: 55 }, { name: 'RRC01', city: 'London', country: 'United Kingdom', total: 77, seeing: 70 }]);
  switch (scenario) {
    case 'healthy':
      return { rs: routingStatusData(prefix, { seen: 320, total: 325, origins: [RTE_ORIGIN] }), rpki: rpkiData(prefix, 'valid'), lg: lookingGlassData([[8218, upstream, RTE_ORIGIN], [3333, upstream, RTE_ORIGIN]]), vis: okVis };
    case 'degraded':
      return { rs: routingStatusData(prefix, { seen: 140, total: 325, origins: [RTE_ORIGIN] }), rpki: rpkiData(prefix, 'valid'), lg: lookingGlassData([[8218, upstream, RTE_ORIGIN]]), vis: okVis };
    case 'withdrawn_with_cover':
      return { rs: routingStatusData(prefix, { seen: 0, total: 325, origins: [], covering: '89.207.56.0/21' }), rpki: rpkiData(prefix, 'unknown'), lg: lookingGlassData([]), vis: visibilityData(prefix, []) };
    case 'withdrawn':
      return { rs: routingStatusData(prefix, { seen: 0, total: 325, origins: [] }), rpki: rpkiData(prefix, 'unknown'), lg: lookingGlassData([]), vis: visibilityData(prefix, []) };
    case 'unexpected_origin':
      return { rs: routingStatusData(prefix, { seen: 300, total: 325, origins: [64500] }), rpki: rpkiData(prefix, 'invalid'), lg: lookingGlassData([[8218, 64500]]), vis: okVis };
    case 'rpki_invalid':
      return { rs: routingStatusData(prefix, { seen: 320, total: 325, origins: [RTE_ORIGIN] }), rpki: rpkiData(prefix, 'invalid'), lg: lookingGlassData([[8218, upstream, RTE_ORIGIN]]), vis: okVis };
    case 'unavailable':
      return { fail: true };
  }
}

export interface MockRipestatOptions {
  scenarioFor?: (prefix: string) => RipeScenario;
  now?: () => number;
}

export class MockRipestatClient implements RipestatClient {
  constructor(private readonly opts: MockRipestatOptions = {}) {}
  private fetched<T>(data: T): Fetched<T> { return { data, fetchedAt: new Date(this.opts.now?.() ?? Date.now()).toISOString() }; }
  private resp(prefix: string) {
    const s = this.opts.scenarioFor?.(prefix) ?? 'healthy';
    const r = scenarioResponses(prefix, s);
    if (r.fail) throw new RipeError('RIPE_NETWORK', 'mock: RIPE unavailable');
    return r;
  }
  async routingStatus(resource: string) { const r = this.resp(resource); if (!r.rs) throw new RipeError('RIPE_HTTP', 'no data'); return this.fetched(r.rs); }
  async rpkiValidation(_asn: number, prefix: string) { const r = this.resp(prefix); if (!r.rpki) throw new RipeError('RIPE_HTTP', 'no data'); return this.fetched(r.rpki); }
  async lookingGlass(prefix: string) { const r = this.resp(prefix); return this.fetched(r.lg ?? { rrcs: [] }); }
  async visibility(prefix: string) { const r = this.resp(prefix); return this.fetched(r.vis ?? { visibilities: [] }); }
}

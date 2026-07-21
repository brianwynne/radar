// RIPE Atlas resolver-reader client. READS the latest results of the recurring per-ISP DNS
// measurements, decodes each resolver's answer, and aggregates per ISP. The API key is sent in the
// Authorization header and never logged. Aggregation is a pure function (buildIspView) so it is
// unit-tested against real captured results.
import { isPublicResolver, parseDnsAbuf, parseWhoami, summarizeChain } from './decode.js';
import type { AtlasConfig, AtlasIspMeasurement } from './config.js';
import type { ResolverIspIdentity, ResolverIspView, ResolverSample, ResolverSnapshot } from './types.js';

export interface AtlasResolverClient {
  getSnapshot(): Promise<ResolverSnapshot>;
}

/** One raw RIPE Atlas DNS result row (only the fields we use). */
interface AtlasResult {
  prb_id?: number;
  timestamp?: number;
  resultset?: { dst_addr?: string; time?: number; result?: { abuf?: string } }[];
  result?: { abuf?: string };
}

// The NS1 record (*.nsone.rte.ie) is THE steering record: while a resolver holds its CNAME cached it
// will not return to NS1, so NS1 cannot re-steer / shed those users until it expires. A record TTL
// above this ceiling means steering is impeded (NS1's decision is frozen for up to that long). The
// liveedge A TTL is a DIFFERENT layer (Cloudflare LB pool refresh) and does NOT govern NS1 steering.
const STEER_TTL_CEILING = 60;

const iso = (epochSec: number | null | undefined): string | null =>
  epochSec ? new Date(epochSec * 1000).toISOString() : null;
const vipPrefix = (ip: string): string => ip.split('.').slice(0, 3).join('.');
const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** Aggregate one ISP's raw Atlas results into a resolver view. Pure. */
export function buildIspView(m: AtlasIspMeasurement, results: AtlasResult[], honourTtlThreshold: number): ResolverIspView {
  if (m.measurementId === null) {
    return {
      isp: m.isp, asn: m.asn, measurementId: null, covered: false,
      note: 'No RIPE Atlas probe coverage for this ISP.',
      probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, platforms: {}, pools: {}, recordName: null, edgeName: null, vips: [], edgeTtl: null, apexTtl: null, recordTtl: null, steeringImpeded: null, steeringWindowSecs: null, honoursLowTtl: null, observedAt: null, samples: [],
    };
  }
  const samples: ResolverSample[] = [];
  const probes = new Set<number>();
  const resolvers = new Set<string>();
  const publicResolvers = new Set<string>();
  const platforms: Record<string, number> = {};
  const pools: Record<string, number> = {};
  const edgeTtls: number[] = [];
  const apexTtls: number[] = [];
  const recordTtls: number[] = [];
  // The chain hostnames + resolved IPs, captured from the ISP's OWN (on-net) recursive resolvers.
  let recordName: string | null = null;
  let edgeName: string | null = null;
  const vipSet = new Set<string>();
  let latest = 0;

  for (const r of results) {
    const prb = r.prb_id ?? -1;
    const when = r.timestamp ?? 0;
    if (when > latest) latest = when;
    // Probe-resolver measurements carry a `resultset` (one per resolver); single-resolver ones
    // carry a top-level `result`.
    const entries = r.resultset && r.resultset.length ? r.resultset : r.result ? [{ result: r.result, dst_addr: undefined, time: when }] : [];
    for (const e of entries) {
      const abuf = e.result?.abuf;
      if (!abuf) continue;
      const s = summarizeChain(parseDnsAbuf(abuf));
      const resolver = e.dst_addr ?? 'probe-resolver';
      const pub = isPublicResolver(resolver);
      const key = `${prb}:${resolver}`;
      probes.add(prb);
      resolvers.add(key);
      if (pub) publicResolvers.add(key);
      // Headline aggregates (platform / pool / TTL) reflect the ISP's OWN resolvers only.
      if (!pub) {
        if (s.platform) inc(platforms, s.platform);
        for (const v of s.vips) { if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) inc(pools, vipPrefix(v)); vipSet.add(v); }
        if (s.edgeTtl !== null) edgeTtls.push(s.edgeTtl);
        if (s.apexTtl !== null) apexTtls.push(s.apexTtl);
        if (s.recordTtl !== null) recordTtls.push(s.recordTtl);
        if (!recordName && s.recordName) recordName = s.recordName;
        if (!edgeName && s.target) edgeName = s.target;
      }
      samples.push({ probeId: prb, resolver, public: pub, platform: s.platform, target: s.target, vips: s.vips, apexTtl: s.apexTtl, recordTtl: s.recordTtl, edgeTtl: s.edgeTtl, observedAt: iso(e.time ?? when) });
    }
  }

  const range = (xs: number[]) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null);
  const edge = range(edgeTtls);
  const record = range(recordTtls);
  return {
    isp: m.isp, asn: m.asn, measurementId: m.measurementId, covered: true,
    probeCount: probes.size, resolverCount: resolvers.size,
    ispResolverCount: resolvers.size - publicResolvers.size, publicResolverCount: publicResolvers.size,
    platforms, pools,
    recordName, edgeName, vips: [...vipSet].sort(),
    edgeTtl: edge, apexTtl: range(apexTtls), recordTtl: record,
    // NS1-record TTL governs steering agility (see STEER_TTL_CEILING). This is the metric that matters.
    steeringImpeded: record ? record.max > STEER_TTL_CEILING : null,
    steeringWindowSecs: record ? record.max : null,
    honoursLowTtl: edge ? edge.max <= honourTtlThreshold : null,
    observedAt: iso(latest), samples,
  };
}

const provenance = (source: 'ripe-atlas' | 'mock' | 'disabled', notice?: string): ResolverSnapshot['provenance'] => ({
  source, synthetic: source !== 'ripe-atlas', readOnly: true, informationalOnly: true, notice, retrievedAt: new Date().toISOString(),
});

/** Live client — fetches the latest results for each configured measurement. */
export class HttpAtlasClient implements AtlasResolverClient {
  constructor(private readonly cfg: AtlasConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async latest(id: number): Promise<AtlasResult[]> {
    const res = await this.fetchImpl(`${this.cfg.endpoint}/measurements/${id}/latest/`, { headers: { Authorization: `Key ${this.cfg.apiKey}` } });
    if (!res.ok) throw new Error(`RIPE Atlas ${res.status} for measurement ${id}`);
    const j = await res.json();
    return Array.isArray(j) ? (j as AtlasResult[]) : [];
  }

  async getSnapshot(): Promise<ResolverSnapshot> {
    const warnings: string[] = [];
    const isps = await Promise.all(this.cfg.measurements.map(async (m) => {
      if (m.measurementId === null) return buildIspView(m, [], this.cfg.honourTtlThreshold);
      try {
        return buildIspView(m, await this.latest(m.measurementId), this.cfg.honourTtlThreshold);
      } catch (err) {
        warnings.push(`${m.isp}: ${err instanceof Error ? err.message : 'fetch failed'}`);
        return buildIspView({ ...m, measurementId: m.measurementId }, [], this.cfg.honourTtlThreshold);
      }
    }));
    const observedAt = isps.map((i) => i.observedAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    return { provenance: provenance('ripe-atlas'), isps, observedAt, target: this.cfg.target, warnings };
  }
}

export class DisabledAtlasClient implements AtlasResolverClient {
  constructor(private readonly cfg: AtlasConfig) {}
  async getSnapshot(): Promise<ResolverSnapshot> {
    return { provenance: provenance('disabled', 'RIPE Atlas resolver reader is disabled.'), isps: [], observedAt: null, target: this.cfg.target, warnings: [] };
  }
}

/** Aggregate one ISP's whoami results into its distinct REAL upstream resolvers + ECS behaviour.
 *  Pierces CPE forwarders: the `ns` value is the actual recursive resolver, the `ecs` value is the
 *  client-subnet it forwards to NS1 (which governs steering precision). Pure. */
export function buildIdentityView(m: AtlasIspMeasurement, results: AtlasResult[]): ResolverIspIdentity {
  if (m.measurementId === null) {
    return { isp: m.isp, asn: m.asn, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, resolvers: [], sendsEcs: false, ecsPrefixes: [], observedAt: null };
  }
  // resolver IP -> { probes, ecs, ecsPrefix }
  const byResolver = new Map<string, { probes: Set<number>; ecs: string | null; ecsPrefix: number | null }>();
  let latest = 0;
  for (const r of results) {
    const prb = r.prb_id ?? -1;
    if ((r.timestamp ?? 0) > latest) latest = r.timestamp ?? 0;
    const entries = r.resultset && r.resultset.length ? r.resultset : r.result ? [{ result: r.result }] : [];
    for (const e of entries) {
      const abuf = e.result?.abuf;
      if (!abuf) continue;
      const w = parseWhoami(parseDnsAbuf(abuf));
      if (!w.ns) continue;
      let rec = byResolver.get(w.ns);
      if (!rec) { rec = { probes: new Set(), ecs: null, ecsPrefix: null }; byResolver.set(w.ns, rec); }
      rec.probes.add(prb);
      if (w.ecs && !rec.ecs) { rec.ecs = w.ecs; rec.ecsPrefix = w.ecsPrefix; }
    }
  }
  const resolvers = [...byResolver.entries()]
    .map(([resolver, v]) => ({ resolver, public: isPublicResolver(resolver), probeCount: v.probes.size, ecs: v.ecs, ecsPrefix: v.ecsPrefix }))
    // ISP's own recursives first, then public; within each, most-probes-first.
    .sort((a, b) => Number(a.public) - Number(b.public) || b.probeCount - a.probeCount);
  const own = resolvers.filter((r) => !r.public);
  const ecsPrefixes = [...new Set(own.map((r) => r.ecsPrefix).filter((x): x is number => x !== null))].sort((a, b) => a - b);
  return {
    isp: m.isp, asn: m.asn, covered: true,
    resolverCount: resolvers.length,
    ispResolverCount: own.length, publicResolverCount: resolvers.length - own.length,
    resolvers,
    sendsEcs: own.some((r) => r.ecs !== null),
    ecsPrefixes, observedAt: iso(latest),
  };
}

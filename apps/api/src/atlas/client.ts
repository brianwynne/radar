// RIPE Atlas resolver-reader client. READS the latest results of the recurring per-ISP DNS
// measurements, decodes each resolver's answer, and aggregates per ISP. The API key is sent in the
// Authorization header and never logged. Aggregation is a pure function (buildIspView) so it is
// unit-tested against real captured results.
import { isPublicResolver, parseDnsAbuf, summarizeChain } from './decode.js';
import type { AtlasConfig, AtlasIspMeasurement } from './config.js';
import type { ResolverIspView, ResolverSample, ResolverSnapshot } from './types.js';

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
      probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, platforms: {}, pools: {}, edgeTtl: null, apexTtl: null, recordTtl: null, honoursLowTtl: null, observedAt: null, samples: [],
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
        for (const v of s.vips) if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) inc(pools, vipPrefix(v));
        if (s.edgeTtl !== null) edgeTtls.push(s.edgeTtl);
        if (s.apexTtl !== null) apexTtls.push(s.apexTtl);
        if (s.recordTtl !== null) recordTtls.push(s.recordTtl);
      }
      samples.push({ probeId: prb, resolver, public: pub, platform: s.platform, target: s.target, vips: s.vips, apexTtl: s.apexTtl, recordTtl: s.recordTtl, edgeTtl: s.edgeTtl, observedAt: iso(e.time ?? when) });
    }
  }

  const range = (xs: number[]) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null);
  const edge = range(edgeTtls);
  return {
    isp: m.isp, asn: m.asn, measurementId: m.measurementId, covered: true,
    probeCount: probes.size, resolverCount: resolvers.size,
    ispResolverCount: resolvers.size - publicResolvers.size, publicResolverCount: publicResolvers.size,
    platforms, pools,
    edgeTtl: edge, apexTtl: range(apexTtls), recordTtl: range(recordTtls),
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

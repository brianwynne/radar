// RADAR resolver-reader model. Read-only observability of what each ISP's own recursive resolvers
// return for the steering record (live.rte.ie), sourced from RIPE Atlas DNS measurements run from
// probes inside each ISP's ASN. INFORMATIONAL only — RADAR issues no writes on the hot path.

export interface AtlasProvenance {
  source: 'ripe-atlas' | 'mock' | 'disabled';
  synthetic: boolean;
  readOnly: true;
  informationalOnly: true;
  notice?: string;
  retrievedAt: string;
}

/** One resolver's answer (a probe may use several resolvers → several of these). */
export interface ResolverSample {
  probeId: number;
  /** The resolver the probe queried. */
  resolver: string;
  /** True when `resolver` is a well-known PUBLIC resolver (Google/Quad9/…), not the ISP's own. */
  public: boolean;
  platform: string | null;
  target: string | null;
  vips: string[];
  /** apex = live.rte.ie pointer TTL; record = NS1 record TTL (shed-relevant); edge = liveedge A TTL. */
  apexTtl: number | null;
  recordTtl: number | null;
  edgeTtl: number | null;
  observedAt: string | null;
}

/** Aggregated resolver view for one ISP. */
export interface ResolverIspView {
  isp: string;
  asn: number;
  measurementId: number | null;
  /** null → no RIPE Atlas probe coverage for this ISP (e.g. Three / AS13280). */
  covered: boolean;
  note?: string;
  probeCount: number;
  resolverCount: number;
  /** Of `resolverCount`, how many are the ISP's own vs well-known public resolvers. The headline
   *  aggregates below (platforms/pools/TTL) are computed from the ISP's OWN resolvers. */
  ispResolverCount: number;
  publicResolverCount: number;
  /** platform → number of the ISP's own resolvers landing on it. */
  platforms: Record<string, number>;
  /** VIP /24 (e.g. "185.54.104") → count — surfaces the Cloudflare CW/PW pool split. */
  pools: Record<string, number>;
  /** Observed edge (liveedge A) TTL range. A max well above what we set = the resolver caps/floors. */
  edgeTtl: { min: number; max: number } | null;
  apexTtl: { min: number; max: number } | null;
  /** Observed NS1-record (livebase/live) TTL range — the shed-relevant one. */
  recordTtl: { min: number; max: number } | null;
  /** True when every observed edge TTL is ≤ the honour threshold (resolvers respect the low TTL). */
  honoursLowTtl: boolean | null;
  observedAt: string | null;
  samples: ResolverSample[];
}

export interface ResolverSnapshot {
  provenance: AtlasProvenance;
  isps: ResolverIspView[];
  observedAt: string | null;
  /** The record whose steering we observe (for the header). */
  target: string;
  warnings: string[];
  /** Whether the 6-hourly recurring baseline is running (credits) or paused. */
  pollingEnabled?: boolean;
}

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

// ---- Resolver identity (whoami) — the ISP's ACTUAL upstream resolvers + ECS behaviour ----------
export interface ResolverIdentityEntry {
  /** The real recursive resolver IP (behind any CPE forwarder). */
  resolver: string;
  /** True when this real resolver is a public one (e.g. a CPE forwarding to Cloudflare/Google),
   *  not the ISP's own recursive. */
  public: boolean;
  /** How many probes reach the ISP via this resolver. */
  probeCount: number;
  /** The EDNS Client Subnet this resolver forwards to NS1 (e.g. "51.171.0.0/24"), or null. */
  ecs: string | null;
  ecsPrefix: number | null;
}
export interface ResolverIspIdentity {
  isp: string;
  asn: number;
  covered: boolean;
  note?: string;
  resolverCount: number;
  /** Of resolverCount, how many are the ISP's own recursives vs public resolvers reached via a CPE. */
  ispResolverCount: number;
  publicResolverCount: number;
  /** Distinct real upstream resolvers, ISP's own first then public, each most-probes-first. */
  resolvers: ResolverIdentityEntry[];
  /** True if any of the ISP's OWN resolvers forward ECS → NS1 can steer per-subnet. */
  sendsEcs: boolean;
  /** Distinct ECS source-prefix lengths observed on the ISP's OWN resolvers (finer = more precise). */
  ecsPrefixes: number[];
  observedAt: string | null;
}
export interface ResolverIdentitySnapshot {
  provenance: AtlasProvenance;
  isps: ResolverIspIdentity[];
  observedAt: string | null;
  warnings: string[];
}

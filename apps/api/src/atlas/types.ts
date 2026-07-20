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
  /** The resolver the probe queried (its ISP resolver). */
  resolver: string;
  platform: string | null;
  target: string | null;
  vips: string[];
  apexTtl: number | null;
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
  /** platform → number of resolvers landing on it. */
  platforms: Record<string, number>;
  /** VIP /24 (e.g. "185.54.104") → count — surfaces the Cloudflare CW/PW pool split. */
  pools: Record<string, number>;
  /** Observed edge (liveedge A) TTL range. A max well above what we set = the resolver caps/floors. */
  edgeTtl: { min: number; max: number } | null;
  apexTtl: { min: number; max: number } | null;
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

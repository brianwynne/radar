// Canonical, vendor-neutral model for Touchstream delivery monitoring. Touchstream wire shapes
// NEVER escape the adapter/http-client — everything above this boundary works in these types, the
// same discipline the CloudVision connector follows.
//
// PROVENANCE (this matters, see docs/architecture/touchstream-delivery.md): Touchstream probes from
// CLOUD/DATACENTRE vantage points, so this is *observed synthetic delivery*, not viewer traffic. It
// can never say what an Eir/Vodafone/Three subscriber received. Nothing here may be presented as the
// "actual traffic" tier.

/** Delivery platform, aligned with RADAR's steering vocabulary (engine PLATFORM_PATTERNS) plus the
 *  radio origin Touchstream labels GENERIC. `Unknown` is honest: an operator CDN label RADAR has no
 *  platform for (never guessed into a known one). */
export type DeliveryPlatform = 'Réalta' | 'Fastly' | 'Akamai' | 'CloudFront' | 'Triton' | 'Unknown';

/** One ABR rendition check within a single probe. `speed` is Touchstream's own figure, carried
 *  through unconverted — the API does not state a unit, so RADAR must not label one. */
export interface TouchstreamRendition {
  name: string;
  sequence: number;
  /** Touchstream's `bitrate` field: sometimes a rate, sometimes a track id (`txt_en`, `audio_ead`). */
  label: string | null;
  resolution: string | null;
  ok: boolean;
  httpStatus: string | null;
  statusText: string | null;
  stalled: boolean;
  speed: number | null;
  contentSize: number | null;
  durationMs: number | null;
}

/** One probe location's view of one monitored stream. */
export interface TouchstreamVantage {
  /** Touchstream location code, e.g. `IE-D-AWS`. */
  location: string;
  country: string | null;
  region: string | null;
  supplier: string | null;
  popIp: string | null;
  /** The edge that actually served this probe — the basis for attribution below. */
  edgeIp: string | null;
  ok: boolean;
  statusPct: number | null;
  avgSpeed: number | null;
  renditions: TouchstreamRendition[];
  /** True when `edgeIp` falls inside an RTÉ-owned prefix (config-driven, not guessed). */
  edgeIsRteOwned: boolean | null;
}

/** One monitored stream = channel × format × CDN label, as configured in Touchstream. */
export interface TouchstreamMonitor {
  streamKey: string;
  channel: string;
  product: string;
  format: string;
  /** The operator's own CDN label in Touchstream (e.g. `RTE CDN`, `GOOGLE`). Kept verbatim. */
  cdnLabel: string;
  /** What that label CLAIMS, mapped into RADAR's vocabulary. A claim, not an observation. */
  platformClaimed: DeliveryPlatform;
  environment: string;
  manifestUrl: string;
  plannedOutage: boolean;
  lastMonitoredAt: string | null;
  ok: boolean;
  statusPct: number | null;
  /** Touchstream's rolling status window, oldest→newest. Drives the cell sparkline. */
  history: number[];
  historyPct: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  vantages: TouchstreamVantage[];
  /** Per-monitor findings the adapter derived (attribution mismatch, no probes, …). */
  warnings: TouchstreamWarning[];
}

export type TouchstreamWarningKind =
  | 'attribution_mismatch'
  | 'no_vantages'
  | 'stalled_rendition'
  | 'planned_outage';

export interface TouchstreamWarning {
  kind: TouchstreamWarningKind;
  message: string;
}

/** A matrix cell: one channel+format row against one platform column. `monitor === null` means NOT
 *  MONITORED — the single most important distinction on the page, because an absent cell must never
 *  read as healthy. */
export interface TouchstreamCell {
  platform: DeliveryPlatform;
  cdnLabel: string | null;
  monitor: TouchstreamMonitor | null;
  /** Average speed over the ROW's shared locations only — the sole figure that compares CDNs fairly
   *  when they are probed from different places. Null when the row has no shared location. */
  sharedSpeed: number | null;
  /** How many probe locations that average is drawn from. */
  sharedLocationCount: number;
  /** Probe locations this platform has that the rest of the row does not (and so cannot be compared
   *  on) — the field that surfaces "no Irish probe on this CDN". */
  unsharedLocations: string[];
}

/** How far a row's platforms can honestly be compared on speed. Two separate questions:
 *   * `comparable`         — does ANY probe location exist that every monitored platform uses? If so
 *                            a like-for-like comparison is possible, restricted to those locations.
 *   * `headlineComparable` — do they all use the SAME location set? Only then are the per-monitor
 *                            headline averages directly comparable; otherwise those averages are
 *                            computed over different geography and must not be read side by side. */
export interface TouchstreamComparability {
  comparable: boolean;
  headlineComparable: boolean;
  /** Locations probed by EVERY monitored platform in this row (empty ⇒ no like-for-like exists). */
  sharedLocations: string[];
  reason: string | null;
}

export interface TouchstreamRow {
  channel: string;
  format: string;
  cells: TouchstreamCell[];
  comparability: TouchstreamComparability;
}

export interface TouchstreamSummary {
  monitorCount: number;
  channelCount: number;
  platformCount: number;
  okCount: number;
  failingCount: number;
  plannedOutageCount: number;
  /** Monitored cells ÷ (rows × platform columns), as a percentage. */
  coveragePercent: number;
  monitoredCells: number;
  possibleCells: number;
  vantageCount: number;
  attributionMismatchCount: number;
  incomparableRowCount: number;
  /** Oldest `lastMonitoredAt` across monitors, in seconds — the page's freshness signal. */
  oldestSampleAgeSeconds: number | null;
}

export interface TouchstreamSnapshot {
  capturedAt: string;
  source: 'mock' | 'live';
  monitors: TouchstreamMonitor[];
  /** Platform columns actually present, in RADAR's canonical order. */
  platforms: DeliveryPlatform[];
  rows: TouchstreamRow[];
  summary: TouchstreamSummary;
  /** Snapshot-level findings (incomparable rows, mislabelled CDNs) for the page banner. */
  warnings: TouchstreamWarning[];
}

/** A probe location as described by Touchstream's location groups. */
export interface TouchstreamLocation {
  code: string;
  country: string | null;
  region: string | null;
  supplier: string | null;
  ipAddresses: string[];
  groups: string[];
}

// --- Windowed history (fetched on demand, never persisted by RADAR) --------------------------

/** Per CDN+format aggregate over a window, from Touchstream's own statistics. */
export interface TouchstreamStat {
  cdnLabel: string;
  platform: DeliveryPlatform;
  format: string;
  product: string | null;
  executions: number | null;
  requests: number | null;
  errors: number | null;
  failures: number | null;
  errorPercent: number | null;
  failPercent: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  p95: number | null;
  stdev: number | null;
}

export interface TouchstreamErrorEntry {
  at: string;
  channel: string | null;
  cdnLabel: string;
  platform: DeliveryPlatform;
  format: string | null;
  location: string | null;
  urlName: string | null;
  url: string | null;
  statusCode: string | null;
  statusText: string | null;
  plannedOutage: boolean;
}

export interface TouchstreamHistory {
  fromMs: number;
  toMs: number;
  environment: string;
  stats: TouchstreamStat[];
  errors: TouchstreamErrorEntry[];
  truncated: boolean;
}

// ALL Touchstream business logic lives here: wire → canonical model, CDN-label → platform mapping,
// edge-IP attribution, probe-comparability, coverage and summary. Pure functions, no I/O.
//
// Two rules shape this file, both learned from the live rtel data:
//
//  1. A CDN LABEL IS A CLAIM, NOT AN OBSERVATION. RTÉ's "GOOGLE" monitors point at a different
//     origin (www.rte.ie/player-live/…) than the live.rte.ie ones, and are largely served from
//     185.54.104.x / 89.207.56.x — RTÉ's own prefixes. Live polling showed the split MOVES: at one
//     poll all four probes were RTÉ-served, seconds later one had a genuine Google edge. So the
//     adapter maps the label for display, independently checks each observed edge, and reports a
//     PROPORTION (all probes → attribution_mismatch, some → attribution_split) rather than an
//     absolute claim either way. We assert only against prefixes we OWN (config-driven); RADAR ships
//     no guessed table of third-party CDN ranges, and an unevaluable edge stays null, never "not ours".
//
//  2. SPEED IS ONLY COMPARABLE FROM THE SAME PLACE. In the live config, RTE 1 on Fastly/Akamai is
//     probed from Paris/Frankfurt while Réalta is probed from Dublin, so comparing their figures
//     compares geography. Every row therefore carries an explicit comparability verdict.
import type {
  DeliveryPlatform,
  MediaKind,
  TouchstreamCell,
  TouchstreamComparability,
  TouchstreamErrorEntry,
  TouchstreamHistory,
  TouchstreamLocation,
  TouchstreamMonitor,
  TouchstreamRendition,
  TouchstreamRow,
  TouchstreamSnapshot,
  TouchstreamStat,
  TouchstreamSummary,
  TouchstreamVantage,
  TouchstreamWarning,
} from './types.js';
import type { TsError, TsLocationGroup, TsRendition, TsStat, TsStreamFull } from './wire.js';

/** Column order for the delivery matrix: RADAR's steering platforms first, then radio, then unknown. */
export const PLATFORM_ORDER: DeliveryPlatform[] = ['Réalta', 'Fastly', 'Akamai', 'CloudFront', 'Triton', 'Unknown'];

const platformRank = (p: DeliveryPlatform): number => {
  const i = PLATFORM_ORDER.indexOf(p);
  return i === -1 ? PLATFORM_ORDER.length : i;
};

/** Touchstream CDN label → the platform it CLAIMS to be. Unrecognised labels stay `Unknown` rather
 *  than being forced into a known platform — the label is the operator's, not ours. */
export function platformForCdnLabel(label: string | null | undefined): DeliveryPlatform {
  const l = (label ?? '').trim().toUpperCase();
  if (l === '') return 'Unknown';
  if (l.includes('RTE') || l.includes('REALTA') || l.includes('RÉALTA')) return 'Réalta';
  if (l.includes('FASTLY')) return 'Fastly';
  if (l.includes('AKAMAI')) return 'Akamai';
  if (l.includes('CLOUDFRONT')) return 'CloudFront';
  // Touchstream labels the Triton/StreamTheWorld radio origin GENERIC.
  if (l.includes('GENERIC') || l.includes('TRITON')) return 'Triton';
  return 'Unknown';
}

/** Video or audio.
 *
 *  TRITON IS ALWAYS AUDIO — confirmed by RTÉ, so it is checked first and decides on its own. Triton
 *  (Touchstream labels it GENERIC) is the radio origin and carries nothing else, so no product text
 *  can override it.
 *
 *  Otherwise the verdict comes from Touchstream's OWN product label: `Live Triton HLS Radio` for
 *  radio, plain `Live` for television. An unrecognised product is treated as video rather than
 *  guessed at, and the raw product travels with the monitor so an operator can see why a stream
 *  landed where it did instead of having to trust the classification. */
export function mediaKindOf(product: string | null | undefined, platform: DeliveryPlatform): MediaKind {
  if (platform === 'Triton') return 'audio'; // invariant, not a heuristic
  return /\b(radio|audio)\b/i.test(product ?? '') ? 'audio' : 'video';
}

// --- IPv4 prefix containment (no dependency; IPv6 edges are reported as unknown) ---------------

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
};

/** Whether an IPv4 address falls inside a CIDR. Returns null when either side is unparseable (an
 *  IPv6 edge, say) — null means "cannot tell", never "no". */
export function ipInPrefix(ip: string, cidr: string): boolean | null {
  const [net, lenRaw] = cidr.split('/');
  const len = Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > 32) return null;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net ?? '');
  if (a === null || b === null) return null;
  if (len === 0) return true;
  const mask = len === 32 ? 0xffffffff : (0xffffffff << (32 - len)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** True/false when determinable, null when the address cannot be evaluated. */
export function isOwnedEdge(ip: string | null | undefined, prefixes: string[]): boolean | null {
  if (!ip) return null;
  let sawComparable = false;
  for (const cidr of prefixes) {
    const hit = ipInPrefix(ip, cidr);
    if (hit === true) return true;
    if (hit === false) sawComparable = true;
  }
  return sawComparable ? false : null;
}

// --- scalar coercion ---------------------------------------------------------------------------

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

const toBool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** Touchstream returns these fields as either a scalar or a series; we want one representative
 *  number. For a series, the LAST element is the most recent sample. */
const scalarOrLast = (v: unknown): number | null => {
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const n = toNum(v[i]);
      if (n !== null) return n;
    }
    return null;
  }
  return toNum(v);
};

const epochToIso = (v: unknown): string | null => {
  const n = toNum(v);
  if (n === null || n <= 0) return null;
  // Touchstream uses seconds (sometimes fractional).
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// --- location index ----------------------------------------------------------------------------

/** Flattens Touchstream's location groups into one entry per location code. A code appearing in
 *  several groups accumulates them, so the UI can say which group a probe belongs to. */
export function buildLocationIndex(groups: (TsLocationGroup | null)[]): Map<string, TouchstreamLocation> {
  const out = new Map<string, TouchstreamLocation>();
  for (const g of groups) {
    if (!g || !g.locations) continue;
    const groupName = toStr(g.location_group) ?? toStr(g.key) ?? 'unnamed group';
    for (const [code, loc] of Object.entries(g.locations)) {
      const existing = out.get(code);
      if (existing) {
        if (!existing.groups.includes(groupName)) existing.groups.push(groupName);
        continue;
      }
      out.set(code, {
        code,
        country: toStr(loc.country),
        region: toStr(loc.region),
        supplier: toStr(loc.supplier),
        ipAddresses: (loc.ip_addresses ?? []).filter((s): s is string => typeof s === 'string'),
        groups: [groupName],
      });
    }
  }
  return out;
}

// --- renditions / vantages ---------------------------------------------------------------------

function buildRendition(raw: TsRendition, index: number): TouchstreamRendition {
  return {
    name: toStr(raw.name) ?? `#${index + 1}`,
    sequence: toNum(raw.sequence) ?? index + 1,
    label: toStr(raw.bitrate),
    resolution: toStr(raw.resolution) === 'NA' ? null : toStr(raw.resolution),
    ok: toNum(raw.status) === 1,
    httpStatus: toStr(raw.http_status),
    statusText: toStr(raw.status_text),
    stalled: toBool(raw.stalled_bitrate),
    speed: toNum(raw.speed),
    contentSize: toNum(raw.content_size),
    durationMs: toNum(raw.duration),
  };
}

function buildVantage(
  raw: NonNullable<TsStreamFull['location_detail']>[number],
  locations: Map<string, TouchstreamLocation>,
  ownedPrefixes: string[],
): TouchstreamVantage {
  const code = toStr(raw.location) ?? 'unknown';
  const meta = locations.get(code);
  const renditions = (raw.status_detail ?? []).map(buildRendition);
  const statusPct = toNum(raw.historical_status_pct);
  const edgeIp = toStr(raw.edge_ip_addr);
  return {
    location: code,
    country: meta?.country ?? null,
    region: meta?.region ?? null,
    supplier: meta?.supplier ?? null,
    popIp: toStr(raw.pop_ip_addr),
    edgeIp,
    // A vantage is OK when nothing it checked failed; an empty check list is not a pass.
    ok: renditions.length > 0 ? renditions.every((r) => r.ok) : statusPct === 100,
    statusPct,
    avgSpeed: toNum(raw.historical_avg_speed_avg) ?? scalarOrLast(raw.historical_avg_speed),
    renditions,
    edgeIsRteOwned: isOwnedEdge(edgeIp, ownedPrefixes),
  };
}

// --- monitors ----------------------------------------------------------------------------------

export function buildMonitor(
  raw: TsStreamFull,
  locations: Map<string, TouchstreamLocation>,
  ownedPrefixes: string[],
): TouchstreamMonitor {
  const cdnLabel = toStr(raw.cdn) ?? 'UNKNOWN';
  const platformClaimed = platformForCdnLabel(cdnLabel);
  const vantages = (raw.location_detail ?? []).map((v) => buildVantage(v, locations, ownedPrefixes));
  const warnings: TouchstreamWarning[] = [];

  // Finding 1: the label claims a third-party CDN but RTÉ's own infrastructure served it (or the
  // reverse). Only asserted where the edge IP is conclusively inside/outside a prefix we own.
  const owned = vantages.filter((v) => v.edgeIsRteOwned === true);
  const notOwned = vantages.filter((v) => v.edgeIsRteOwned === false);
  // NOTE the condition is "the label does not claim RTÉ's own CDN" — deliberately including labels
  // RADAR cannot map to a platform. The live "GOOGLE" monitors are exactly that case: unmappable
  // label, RTÉ-owned edges. Excluding Unknown here would have silently hidden the finding.
  if (platformClaimed !== 'Réalta' && owned.length > 0 && notOwned.length === 0) {
    warnings.push({
      kind: 'attribution_mismatch',
      message: `Labelled "${cdnLabel}" but every probe was served from an RTÉ-owned prefix (${owned
        .map((v) => v.edgeIp)
        .filter(Boolean)
        .join(', ')}) — this monitor is measuring RTÉ's own delivery, not ${cdnLabel}.`,
    });
  } else if (platformClaimed !== 'Réalta' && owned.length > 0 && notOwned.length > 0) {
    // Mixed: report the proportion. Claiming either extreme would misstate what was observed.
    warnings.push({
      kind: 'attribution_split',
      message: `Labelled "${cdnLabel}" but ${owned.length} of ${owned.length + notOwned.length} probes were served from an RTÉ-owned prefix (${owned
        .map((v) => `${v.location} → ${v.edgeIp}`)
        .join(', ')}) — this monitor measures ${cdnLabel} from some locations and RTÉ's own delivery from others.`,
    });
  } else if (platformClaimed === 'Réalta' && notOwned.length > 0 && owned.length === 0) {
    warnings.push({
      kind: 'attribution_mismatch',
      message: `Labelled "${cdnLabel}" but no probe was served from an RTÉ-owned prefix (${notOwned
        .map((v) => v.edgeIp)
        .filter(Boolean)
        .join(', ')}).`,
    });
  }
  if (vantages.length === 0) {
    warnings.push({ kind: 'no_vantages', message: 'No probe locations reported for this monitor.' });
  }
  const stalled = vantages.flatMap((v) => v.renditions.filter((r) => r.stalled));
  if (stalled.length > 0) {
    warnings.push({
      kind: 'stalled_rendition',
      message: `${stalled.length} rendition${stalled.length === 1 ? '' : 's'} reported a stalled bitrate.`,
    });
  }
  const plannedOutage = toBool(raw.planned_outage);
  if (plannedOutage) {
    warnings.push({ kind: 'planned_outage', message: 'A planned outage covers this monitor — status is not a fault.' });
  }

  return {
    streamKey: raw.stream_key,
    channel: toStr(raw.channel) ?? 'unknown',
    product: toStr(raw.product) ?? '',
    format: (toStr(raw.format) ?? 'UNKNOWN').toUpperCase(),
    mediaKind: mediaKindOf(toStr(raw.product), platformClaimed),
    cdnLabel,
    platformClaimed,
    environment: toStr(raw.environment) ?? '',
    manifestUrl: toStr(raw.manifest_url) ?? '',
    plannedOutage,
    lastMonitoredAt: epochToIso(raw.last_monitored),
    ok: toNum(raw.current_status) === 1,
    statusPct: toNum(raw.current_status_pct),
    history: (raw.historical_status ?? []).map((n) => toNum(n) ?? 0),
    historyPct: toNum(raw.historical_status_pct),
    avgSpeed: toNum(raw.historical_avg_speed_avg) ?? scalarOrLast(raw.historical_avg_speed),
    maxSpeed: toNum(raw.historical_max_speed_avg) ?? scalarOrLast(raw.historical_max_speed),
    vantages,
    warnings,
  };
}

// --- comparability -----------------------------------------------------------------------------

/** Comparability has two levels, because in the live config they genuinely differ:
 *
 *   * a like-for-like comparison EXISTS if some location is probed by every monitored platform;
 *   * the HEADLINE averages are only comparable if they all probe the SAME set of locations.
 *
 * RTE 1 MPD is the motivating case: all four CDNs share GB-LND-LND, so a fair comparison is
 * available there — but Fastly/Akamai probe FR+DE+GB while Réalta probes IE+GB×3, so their headline
 * averages are computed over different geography and must not be read side by side. Rows with a
 * single monitored platform are trivially comparable, keeping the warning meaningful. */
export function comparabilityOf(cells: TouchstreamCell[]): TouchstreamComparability {
  const monitored = cells.filter((c) => c.monitor !== null).map((c) => c.monitor as TouchstreamMonitor);
  if (monitored.length < 2) {
    return { comparable: true, headlineComparable: true, sharedLocations: locationsOf(monitored[0]), reason: null };
  }
  const sets = monitored.map((m) => new Set(m.vantages.map((v) => v.location)));
  const shared = [...sets[0]].filter((loc) => sets.every((s) => s.has(loc))).sort();
  const union = new Set(sets.flatMap((s) => [...s]));
  const headlineComparable = shared.length === union.size;
  if (shared.length === 0) {
    const detail = monitored.map((m) => `${m.cdnLabel} from ${locationsOf(m).join('/') || 'nowhere'}`).join('; ');
    return {
      comparable: false,
      headlineComparable: false,
      sharedLocations: [],
      reason: `No probe location is shared by every CDN in this row, so no like-for-like comparison exists — ${detail}.`,
    };
  }
  if (!headlineComparable) {
    const missing = monitored
      .filter((m) => locationsOf(m).length !== shared.length)
      .map((m) => `${m.cdnLabel} lacks ${[...union].filter((l) => !sets[monitored.indexOf(m)].has(l)).sort().join('/')}`)
      .join('; ');
    return {
      comparable: true,
      headlineComparable: false,
      sharedLocations: shared,
      reason: `These CDNs are probed from different places, so their headline averages are not like-for-like — compare them at ${shared.join('/')} instead (${missing}).`,
    };
  }
  return { comparable: true, headlineComparable: true, sharedLocations: shared, reason: null };
}

const locationsOf = (m: TouchstreamMonitor | undefined): string[] =>
  m ? m.vantages.map((v) => v.location).sort() : [];

/** Mean of a monitor's per-location speeds restricted to `locations`. */
function speedAt(monitor: TouchstreamMonitor, locations: string[]): number | null {
  const values = monitor.vantages
    .filter((v) => locations.includes(v.location))
    .map((v) => v.avgSpeed)
    .filter((n): n is number => n !== null && Number.isFinite(n));
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

// --- matrix ------------------------------------------------------------------------------------

export function buildRows(monitors: TouchstreamMonitor[], platforms: DeliveryPlatform[]): TouchstreamRow[] {
  const keyOf = (m: TouchstreamMonitor) => `${m.channel} ${m.format}`;
  const groups = new Map<string, TouchstreamMonitor[]>();
  for (const m of monitors) {
    const list = groups.get(keyOf(m));
    if (list) list.push(m);
    else groups.set(keyOf(m), [m]);
  }
  const rows: TouchstreamRow[] = [];
  for (const [key, group] of groups) {
    const [channel, format] = key.split(' ');
    const bare: TouchstreamCell[] = platforms.map((platform) => {
      const monitor = group.find((m) => m.platformClaimed === platform) ?? null;
      return { platform, cdnLabel: monitor?.cdnLabel ?? null, monitor, sharedSpeed: null, sharedLocationCount: 0, unsharedLocations: [] };
    });
    // Comparability first, then the fair per-cell figure it makes possible.
    const comparability = comparabilityOf(bare);
    const cells = bare.map((c) =>
      c.monitor
        ? {
            ...c,
            sharedSpeed: speedAt(c.monitor, comparability.sharedLocations),
            sharedLocationCount: c.monitor.vantages.filter((v) => comparability.sharedLocations.includes(v.location)).length,
            unsharedLocations: c.monitor.vantages.map((v) => v.location).filter((l) => !comparability.sharedLocations.includes(l)).sort(),
          }
        : c,
    );
    rows.push({ channel, format, mediaKind: group[0].mediaKind, cells, comparability });
  }
  // Video before audio, then alphabetical — the page groups on this order.
  const kindRank = (k: MediaKind) => (k === 'video' ? 0 : 1);
  rows.sort((a, b) => kindRank(a.mediaKind) - kindRank(b.mediaKind) || a.channel.localeCompare(b.channel) || a.format.localeCompare(b.format));
  return rows;
}

// --- snapshot ----------------------------------------------------------------------------------

export interface BuildSnapshotInput {
  streams: TsStreamFull[];
  locationGroups: (TsLocationGroup | null)[];
  capturedAt: string;
  source: 'mock' | 'live';
  ownedPrefixes: string[];
  now?: number;
}

export function buildSnapshot(input: BuildSnapshotInput): TouchstreamSnapshot {
  const locations = buildLocationIndex(input.locationGroups);
  const monitors = input.streams
    .map((s) => buildMonitor(s, locations, input.ownedPrefixes))
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.format.localeCompare(b.format) || platformRank(a.platformClaimed) - platformRank(b.platformClaimed));

  const platforms = [...new Set(monitors.map((m) => m.platformClaimed))].sort((a, b) => platformRank(a) - platformRank(b));
  const rows = buildRows(monitors, platforms);

  const nowMs = input.now ?? Date.parse(input.capturedAt);
  // Clamped at 0: Touchstream stamps samples with its own clock, so mild skew must not produce a
  // negative "age" that would render as a future sample.
  const ages = monitors
    .map((m) => (m.lastMonitoredAt ? Math.max(0, (nowMs - Date.parse(m.lastMonitoredAt)) / 1000) : null))
    .filter((n): n is number => n !== null && Number.isFinite(n));

  const monitoredCells = rows.reduce((n, r) => n + r.cells.filter((c) => c.monitor).length, 0);
  const possibleCells = rows.length * platforms.length;
  const attributionMismatches = monitors.filter((m) => m.warnings.some((w) => w.kind === 'attribution_mismatch'));
  const attributionSplits = monitors.filter((m) => m.warnings.some((w) => w.kind === 'attribution_split'));
  const incomparable = rows.filter((r) => !r.comparability.comparable);

  const summary: TouchstreamSummary = {
    monitorCount: monitors.length,
    channelCount: new Set(monitors.map((m) => m.channel)).size,
    platformCount: platforms.length,
    okCount: monitors.filter((m) => m.ok).length,
    failingCount: monitors.filter((m) => !m.ok && !m.plannedOutage).length,
    plannedOutageCount: monitors.filter((m) => m.plannedOutage).length,
    coveragePercent: possibleCells === 0 ? 0 : Math.round((monitoredCells / possibleCells) * 1000) / 10,
    monitoredCells,
    possibleCells,
    vantageCount: new Set(monitors.flatMap((m) => m.vantages.map((v) => v.location))).size,
    videoMonitorCount: monitors.filter((m) => m.mediaKind === 'video').length,
    audioMonitorCount: monitors.filter((m) => m.mediaKind === 'audio').length,
    attributionMismatchCount: attributionMismatches.length,
    attributionSplitCount: attributionSplits.length,
    incomparableRowCount: incomparable.length,
    oldestSampleAgeSeconds: ages.length > 0 ? Math.round(Math.max(...ages)) : null,
  };

  // Snapshot-level warnings roll up what the operator should act on, not every per-monitor note.
  const warnings: TouchstreamWarning[] = [];
  for (const m of [...attributionMismatches, ...attributionSplits]) {
    for (const w of m.warnings.filter((x) => x.kind === 'attribution_mismatch' || x.kind === 'attribution_split')) {
      warnings.push({ kind: w.kind, message: `${m.channel} · ${m.format} · ${w.message}` });
    }
  }
  for (const r of incomparable) {
    warnings.push({ kind: 'attribution_mismatch', message: `${r.channel} · ${r.format} · ${r.comparability.reason}` });
  }

  return { capturedAt: input.capturedAt, source: input.source, monitors, platforms, rows, summary, warnings };
}

// --- windowed history --------------------------------------------------------------------------

export function buildStat(raw: TsStat): TouchstreamStat {
  const cdnLabel = toStr(raw.cdn) ?? 'UNKNOWN';
  return {
    cdnLabel,
    platform: platformForCdnLabel(cdnLabel),
    format: (toStr(raw.format) ?? 'UNKNOWN').toUpperCase(),
    product: toStr(raw.product),
    executions: toNum(raw.executions),
    requests: toNum(raw.requests),
    errors: toNum(raw.errors),
    failures: toNum(raw.failure),
    errorPercent: toNum(raw.error_pct),
    failPercent: toNum(raw.fail_pct),
    min: toNum(raw.min),
    avg: toNum(raw.avg),
    max: toNum(raw.max),
    p95: toNum(raw.p95),
    stdev: toNum(raw.stdev),
  };
}

export function buildErrorEntry(raw: TsError): TouchstreamErrorEntry {
  const cdnLabel = toStr(raw.cdn) ?? 'UNKNOWN';
  return {
    at: epochToIso(raw.time) ?? new Date(0).toISOString(),
    channel: toStr(raw.channel),
    cdnLabel,
    platform: platformForCdnLabel(cdnLabel),
    format: toStr(raw.format),
    location: toStr(raw.location),
    urlName: toStr(raw.url_name),
    url: toStr(raw.url),
    statusCode: toStr(raw.status_code),
    statusText: toStr(raw.status_text),
    plannedOutage: toBool(raw.planned_outage),
  };
}

export function buildHistory(input: {
  stats: TsStat[];
  errors: TsError[];
  fromMs: number;
  toMs: number;
  environment: string;
  maxErrors: number;
}): TouchstreamHistory {
  const errors = input.errors.map(buildErrorEntry).sort((a, b) => b.at.localeCompare(a.at));
  return {
    fromMs: input.fromMs,
    toMs: input.toMs,
    environment: input.environment,
    stats: input.stats.map(buildStat).sort((a, b) => platformRank(a.platform) - platformRank(b.platform) || a.format.localeCompare(b.format)),
    errors: errors.slice(0, input.maxErrors),
    truncated: errors.length > input.maxErrors,
  };
}

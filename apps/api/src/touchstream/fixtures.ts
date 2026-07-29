// Synthetic Touchstream fixtures. SHAPES are faithful to the live rtel payloads (verified
// 2026-07-29); NAMES, URLs and keys are invented, and no credential or token-bypass string appears
// here — this repository is public, so no real monitoring configuration is committed.
//
// The scenarios deliberately reproduce the two real problems found in the live config, so the
// adapter's checks are exercised by tests rather than only by production:
//   * `mislabelled`  — a monitor labelled with a third-party CDN whose edges are RTÉ-owned;
//   * `incomparable` — a channel whose CDNs are probed from disjoint location sets.
import { DEFAULT_OWNED_PREFIXES } from './config.js';
import type { TsError, TsLocationGroup, TsStat, TsStreamFull } from './wire.js';

/** An address inside the first owned prefix (185.54.104.0/22 by default). */
const OWNED_EDGE_A = '185.54.104.4';
const OWNED_EDGE_B = '185.54.105.12';
/** Documentation-range addresses stand in for third-party CDN edges (RFC 5737). */
const THIRD_PARTY_EDGE_A = '198.51.100.10';
const THIRD_PARTY_EDGE_B = '203.0.113.20';

export const FIXTURE_OWNED_PREFIXES = DEFAULT_OWNED_PREFIXES;

const rendition = (seq: number, name: string, label: string, speed: number, ok = true, stalled = false) => ({
  status: ok ? 1 : 0,
  status_text: ok ? 'PASS CONTENT' : 'FAIL URL',
  http_status: ok ? '200' : '404',
  name,
  type: 'Bitrate',
  sequence: seq,
  stalled_bitrate: stalled,
  bitrate: label,
  resolution: 'NA',
  speed,
  content_size: 47358,
  duration: 3840,
});

const vantage = (
  location: string,
  popIp: string,
  edgeIp: string,
  speed: number,
  opts: { ok?: boolean; stalled?: boolean } = {},
) => ({
  location,
  last_monitored: 1785359100,
  pop_ip_addr: popIp,
  edge_ip_addr: edgeIp,
  historical_status: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  historical_status_pct: opts.ok === false ? 60.0 : 100.0,
  historical_avg_speed: [0, 0, 1, 0, 0],
  historical_avg_speed_avg: speed,
  status_detail: [
    { status: 1, status_text: 'PASS CONTENT', http_status: '200', name: 'Manifest', type: 'URL', sequence: 1 },
    rendition(2, 'BR1', 'txt_en', speed, opts.ok !== false),
    rendition(3, 'BR2', 'audio_main', speed, opts.ok !== false, opts.stalled === true),
    rendition(4, 'BR3', '3000000', speed, opts.ok !== false),
  ],
});

const stream = (
  streamKey: string,
  channel: string,
  format: string,
  cdn: string,
  manifest: string,
  locations: ReturnType<typeof vantage>[],
  opts: { ok?: boolean; plannedOutage?: boolean; product?: string } = {},
): TsStreamFull =>
  ({
    stream_key: streamKey,
    channel,
    channel_id: 0,
    // Live values: 'Live' for television, 'Live Triton HLS Radio' for radio — the string the
    // video/audio grouping is derived from.
    product: opts.product ?? 'Live',
    format,
    cdn,
    environment: 'PROD',
    manifest_url: manifest,
    planned_outage: opts.plannedOutage ?? false,
    last_monitored: 1785359100,
    current_status: opts.ok === false ? 0 : 1,
    current_status_pct: opts.ok === false ? 50.0 : 100.0,
    historical_status: [1, 1, 1, 1, 1, opts.ok === false ? 0 : 1, 1, 1, 1, 1],
    historical_status_pct: opts.ok === false ? 90.0 : 100.0,
    historical_avg_speed: [0, 0, 0, 1, 0],
    historical_avg_speed_avg: locations[0]?.historical_avg_speed_avg ?? 0,
    historical_max_speed: [1, 2, 1, 1, 0],
    historical_max_speed_avg: 1.2,
    location_detail: locations,
  }) as TsStreamFull;

// Two disjoint probe sets, mirroring the live "home + Europe" split that breaks comparability.
const HOME = () => [
  vantage('IE-D-AWS', '203.0.113.1', OWNED_EDGE_A, 0.2),
  vantage('GB-LND-AWS', '203.0.113.2', OWNED_EDGE_B, 0.3),
];
const AWAY = () => [
  vantage('FR-IDF-AWS', '203.0.113.3', THIRD_PARTY_EDGE_A, 3.7),
  vantage('DE-BY-AWS', '203.0.113.4', THIRD_PARTY_EDGE_B, 3.9),
];

const M = 'https://stream.example.net/live/x/one/one.isml';

export const LOCATION_GROUPS: (TsLocationGroup | null)[] = [
  {
    key: 'grp-home',
    location_group: 'Home: Ireland & UK',
    locations: {
      'IE-D-AWS': { country: 'Ireland', region: 'Dublin', supplier: 'Amazon Web Services', ip_addresses: ['203.0.113.1'] },
      'GB-LND-AWS': { country: 'England', region: 'London', supplier: 'Amazon Web Services', ip_addresses: ['203.0.113.2'] },
    },
  },
  {
    key: 'grp-eu',
    location_group: 'Europe: France & Germany',
    locations: {
      'FR-IDF-AWS': { country: 'France', region: 'Paris', supplier: 'Amazon Web Services', ip_addresses: ['203.0.113.3'] },
      'DE-BY-AWS': { country: 'Germany', region: 'Frankfurt', supplier: 'Amazon Web Services', ip_addresses: ['203.0.113.4'] },
    },
  },
  // Live payloads include a trailing null element; keep it so parsing stays honest.
  null,
];

/** Healthy baseline: one channel, both formats, own CDN + two third parties, all probed from home. */
export const STREAMS_NORMAL: TsStreamFull[] = [
  stream('s-own-mpd', 'Channel One', 'MPD', 'RTE CDN', `${M}/.mpd`, HOME()),
  stream('s-fastly-mpd', 'Channel One', 'MPD', 'FASTLY', `${M}/.mpd`, [
    vantage('IE-D-AWS', '203.0.113.1', THIRD_PARTY_EDGE_A, 0.4),
    vantage('GB-LND-AWS', '203.0.113.2', THIRD_PARTY_EDGE_B, 0.5),
  ]),
  stream('s-own-hls', 'Channel One', 'HLS', 'RTE CDN', `${M}/.m3u8`, HOME()),
  // Deliberate coverage hole: no Fastly monitor for HLS → the matrix must show NOT MONITORED.
  stream(
    's-radio',
    'Radio One',
    'HLS',
    'GENERIC',
    'https://radio.example.net/live.m3u8',
    [vantage('GB-LND-AWS', '203.0.113.2', '198.51.100.99', 2.5)],
    { product: 'Live Triton HLS Radio' },
  ),
];

/** A monitor labelled AKAMAI whose every probe was served from an RTÉ-owned prefix. */
export const STREAMS_MISLABELLED: TsStreamFull[] = [
  ...STREAMS_NORMAL,
  stream('s-mislabelled', 'Channel Two', 'MPD', 'AKAMAI', 'https://other.example.net/player-live/two/.mpd', [
    vantage('IE-D-AWS', '203.0.113.1', OWNED_EDGE_A, 0.1),
    vantage('GB-LND-AWS', '203.0.113.2', OWNED_EDGE_B, 0.1),
  ]),
];

/** Own CDN probed from home, third party probed from away → nothing shared, not comparable. */
export const STREAMS_INCOMPARABLE: TsStreamFull[] = [
  stream('s-own-mpd', 'Channel One', 'MPD', 'RTE CDN', `${M}/.mpd`, HOME()),
  stream('s-akamai-mpd', 'Channel One', 'MPD', 'AKAMAI', `${M}/.mpd`, AWAY()),
];

/** A failing third-party monitor plus a stalled rendition and a planned outage. */
export const STREAMS_DEGRADED: TsStreamFull[] = [
  stream('s-own-mpd', 'Channel One', 'MPD', 'RTE CDN', `${M}/.mpd`, HOME()),
  stream(
    's-fastly-mpd',
    'Channel One',
    'MPD',
    'FASTLY',
    `${M}/.mpd`,
    [vantage('IE-D-AWS', '203.0.113.1', THIRD_PARTY_EDGE_A, 6.1, { ok: false, stalled: true })],
    { ok: false },
  ),
  stream('s-own-hls', 'Channel One', 'HLS', 'RTE CDN', `${M}/.m3u8`, HOME(), { plannedOutage: true }),
];

export const STATS: TsStat[] = [
  { product: 'Live', format: 'MPD', cdn: 'RTE CDN', executions: 2048, requests: 14189, errors: 12, failure: 1, error_pct: 0.08, fail_pct: 0.05, min: 0.0, avg: 0.2, max: 1.4, p95: 1, stdev: 0.3 },
  { product: 'Live', format: 'MPD', cdn: 'FASTLY', executions: 2048, requests: 14189, errors: 196, failure: 49, error_pct: 1.38, fail_pct: 2.39, min: 0.0, avg: 1.0, max: 14.0, p95: 4, stdev: 2.0 },
  { product: 'Live', format: 'HLS', cdn: 'RTE CDN', executions: 2040, requests: 14000, errors: 3, failure: 0, error_pct: 0.02, fail_pct: 0.0, min: 0.0, avg: 0.1, max: 0.9, p95: 1, stdev: 0.2 },
];

export const ERRORS: TsError[] = [
  { time: 1785358000.0, channel: 'Channel One', channel_key: 'c-one', cdn: 'FASTLY', format: 'MPD', location: 'IE-D-AWS', url_name: 'Get Stream Manifest', url: `${M}/.mpd`, status_code: '500', status_text: 'FAIL URL', planned_outage: 0 },
  { time: 1785357000.0, channel: 'Channel One', channel_key: 'c-one', cdn: 'FASTLY', format: 'HLS', location: 'FR-IDF-AWS', url_name: 'Get Stream Manifest', url: `${M}/.m3u8`, status_code: '503', status_text: 'FAIL URL', planned_outage: 0 },
];

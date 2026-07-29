import { describe, expect, it } from 'vitest';
import {
  buildHistory,
  mediaKindOf,
  buildLocationIndex,
  buildSnapshot,
  comparabilityOf,
  ipInPrefix,
  isOwnedEdge,
  platformForCdnLabel,
} from '../src/touchstream/adapter.js';
import { loadTouchstreamConfig, TouchstreamConfigError, DEFAULT_OWNED_PREFIXES } from '../src/touchstream/config.js';
import { MockTouchstreamClient } from '../src/touchstream/mock-client.js';
import {
  ERRORS,
  LOCATION_GROUPS,
  STATS,
  STREAMS_DEGRADED,
  STREAMS_INCOMPARABLE,
  STREAMS_MISLABELLED,
  STREAMS_NORMAL,
} from '../src/touchstream/fixtures.js';
import type { TouchstreamCell, TouchstreamMonitor } from '../src/touchstream/types.js';

const AT = '2026-07-29T21:20:00.000Z'; // 15 min after the fixtures' last_monitored
const snap = (streams = STREAMS_NORMAL) =>
  buildSnapshot({ streams, locationGroups: LOCATION_GROUPS, capturedAt: AT, source: 'mock', ownedPrefixes: DEFAULT_OWNED_PREFIXES, now: Date.parse(AT) });

describe('platformForCdnLabel', () => {
  it('maps the operator labels seen live', () => {
    expect(platformForCdnLabel('RTE CDN')).toBe('Réalta');
    expect(platformForCdnLabel('FASTLY')).toBe('Fastly');
    expect(platformForCdnLabel('AKAMAI')).toBe('Akamai');
    expect(platformForCdnLabel('CLOUDFRONT')).toBe('CloudFront');
    expect(platformForCdnLabel('GENERIC')).toBe('Triton');
  });

  it('leaves an unrecognised label Unknown rather than guessing it into a platform', () => {
    // "GOOGLE" is a real label in the live config and RADAR has no such steering platform. Forcing
    // it into a known one would be inventing an attribution.
    expect(platformForCdnLabel('GOOGLE')).toBe('Unknown');
    expect(platformForCdnLabel('')).toBe('Unknown');
    expect(platformForCdnLabel(null)).toBe('Unknown');
  });
});

describe('mediaKindOf (video vs audio grouping)', () => {
  it('reads Touchstream\'s own product label', () => {
    // Live values: 'Live' for television, 'Live Triton HLS Radio' for the radio streams.
    expect(mediaKindOf('Live', 'Réalta')).toBe('video');
    expect(mediaKindOf('Live Triton HLS Radio', 'Akamai')).toBe('audio');
  });

  it('always classifies Triton as audio — it carries nothing else', () => {
    // Confirmed by RTÉ: Triton (labelled GENERIC in Touchstream) is the radio origin only, so it
    // decides on its own and no product text can override it.
    expect(mediaKindOf('Live', 'Triton')).toBe('audio');
    expect(mediaKindOf(null, 'Triton')).toBe('audio');
    expect(mediaKindOf('Live Television Feed', 'Triton')).toBe('audio');
  });

  it('defaults an unrecognised product to video rather than inventing a kind', () => {
    expect(mediaKindOf('Something New', 'Fastly')).toBe('video');
    expect(mediaKindOf(null, 'Fastly')).toBe('video');
    // 'audio' as a whole word counts; a substring inside another word does not.
    expect(mediaKindOf('Live Audio Feed', 'Fastly')).toBe('audio');
    expect(mediaKindOf('Audiobook Channel', 'Fastly')).toBe('video');
  });
});

describe('prefix containment', () => {
  it('decides IPv4 membership', () => {
    expect(ipInPrefix('185.54.104.4', '185.54.104.0/22')).toBe(true);
    expect(ipInPrefix('185.54.107.255', '185.54.104.0/22')).toBe(true);
    expect(ipInPrefix('185.54.108.0', '185.54.104.0/22')).toBe(false); // /22 ends at .107.255
    expect(ipInPrefix('89.207.56.166', '89.207.56.0/21')).toBe(true);
    expect(ipInPrefix('151.101.67.52', '185.54.104.0/22')).toBe(false);
  });

  it('returns null when it cannot tell, so "unknown" never reads as "not ours"', () => {
    expect(ipInPrefix('2a00:1ed8::1', '185.54.104.0/22')).toBeNull();
    expect(ipInPrefix('185.54.104.4', 'nonsense')).toBeNull();
    expect(isOwnedEdge(null, DEFAULT_OWNED_PREFIXES)).toBeNull();
    expect(isOwnedEdge('2a00:1ed8::1', DEFAULT_OWNED_PREFIXES)).toBeNull();
  });

  it('checks every owned prefix', () => {
    expect(isOwnedEdge('89.207.56.166', DEFAULT_OWNED_PREFIXES)).toBe(true);
    expect(isOwnedEdge('198.51.100.10', DEFAULT_OWNED_PREFIXES)).toBe(false);
  });
});

describe('buildLocationIndex', () => {
  it('flattens groups, keeps supplier/country/region, and tolerates the trailing null', () => {
    const idx = buildLocationIndex(LOCATION_GROUPS);
    expect(idx.size).toBe(4);
    expect(idx.get('IE-D-AWS')).toMatchObject({ country: 'Ireland', region: 'Dublin', supplier: 'Amazon Web Services' });
    expect(idx.get('IE-D-AWS')!.groups).toEqual(['Home: Ireland & UK']);
  });
});

describe('buildSnapshot — matrix and coverage', () => {
  it('builds one row per channel+format and one cell per platform column', () => {
    const s = snap();
    expect(s.platforms).toEqual(['Réalta', 'Fastly', 'Triton']);
    const one = s.rows.find((r) => r.channel === 'Channel One' && r.format === 'MPD')!;
    expect(one.cells.map((c) => c.platform)).toEqual(['Réalta', 'Fastly', 'Triton']);
    expect(one.cells.find((c) => c.platform === 'Réalta')!.monitor).not.toBeNull();
  });

  it('leaves an unmonitored cell NULL — absence must never render as healthy', () => {
    const s = snap();
    const hls = s.rows.find((r) => r.channel === 'Channel One' && r.format === 'HLS')!;
    expect(hls.cells.find((c) => c.platform === 'Réalta')!.monitor).not.toBeNull();
    expect(hls.cells.find((c) => c.platform === 'Fastly')!.monitor).toBeNull();
  });

  it('reports coverage as monitored cells over possible cells', () => {
    const s = snap();
    // 3 rows × 3 platforms = 9 possible; 4 monitors configured.
    expect(s.summary.possibleCells).toBe(9);
    expect(s.summary.monitoredCells).toBe(4);
    expect(s.summary.coveragePercent).toBeCloseTo(44.4, 1);
  });

  it('summarises health, vantages and sample age', () => {
    const s = snap(STREAMS_DEGRADED);
    expect(s.summary.failingCount).toBe(1);
    expect(s.summary.plannedOutageCount).toBe(1);
    expect(s.summary.vantageCount).toBeGreaterThan(0);
    expect(s.summary.oldestSampleAgeSeconds).toBe(900);
  });

  it('clamps sample age at zero so vendor clock skew never reads as a future sample', () => {
    const early = buildSnapshot({
      streams: STREAMS_NORMAL,
      locationGroups: LOCATION_GROUPS,
      capturedAt: '2026-07-29T20:00:00.000Z', // before the fixtures' last_monitored
      source: 'mock',
      ownedPrefixes: DEFAULT_OWNED_PREFIXES,
      now: Date.parse('2026-07-29T20:00:00.000Z'),
    });
    expect(early.summary.oldestSampleAgeSeconds).toBe(0);
  });

  it('groups video rows before audio and counts each', () => {
    const s = snap();
    expect(s.rows.map((r) => r.mediaKind)).toEqual(['video', 'video', 'audio']);
    expect(s.summary.videoMonitorCount).toBe(3);
    expect(s.summary.audioMonitorCount).toBe(1);
    // The raw product travels with the monitor so the grouping is auditable, not opaque.
    expect(s.monitors.find((m) => m.mediaKind === 'audio')!.product).toContain('Radio');
  });

  it('carries the raw operator CDN label alongside the mapped platform', () => {
    const m = snap().monitors.find((x) => x.platformClaimed === 'Triton')!;
    expect(m.cdnLabel).toBe('GENERIC');
  });
});

describe('buildSnapshot — attribution (the mislabelled-CDN finding)', () => {
  it('flags a third-party label whose every probe was served from an owned prefix', () => {
    const s = snap(STREAMS_MISLABELLED);
    const m = s.monitors.find((x) => x.streamKey === 's-mislabelled')!;
    const w = m.warnings.find((x) => x.kind === 'attribution_mismatch');
    expect(w).toBeDefined();
    expect(w!.message).toContain('AKAMAI');
    expect(w!.message).toContain('RTÉ-owned');
    expect(s.summary.attributionMismatchCount).toBe(1);
    expect(s.warnings.some((x) => x.message.includes('Channel Two'))).toBe(true);
  });

  it('flags an UNMAPPABLE label served from owned edges — the live "GOOGLE" case', () => {
    // RADAR cannot map "GOOGLE" to a platform, but that is no reason to stay quiet: the label does
    // not claim RTÉ's CDN, yet RTÉ's own infrastructure served every probe.
    const streams = structuredClone(STREAMS_NORMAL);
    const cloned = structuredClone(streams.find((x) => x.stream_key === 's-own-mpd')!);
    cloned.stream_key = 's-google-mpd';
    cloned.cdn = 'GOOGLE';
    streams.push(cloned);
    const m = snap(streams).monitors.find((x) => x.streamKey === 's-google-mpd')!;
    expect(m.platformClaimed).toBe('Unknown');
    expect(m.warnings.some((w) => w.kind === 'attribution_mismatch')).toBe(true);
  });

  it('reports a PROPORTION when only some probes were served from owned edges', () => {
    // Observed live and it moves between polls: a "GOOGLE" monitor served from Google at one probe
    // and from RTÉ prefixes at the others. Claiming either extreme would misstate the observation.
    const streams = structuredClone(STREAMS_MISLABELLED);
    const m0 = streams.find((x) => x.stream_key === 's-mislabelled')!;
    (m0.location_detail![0] as { edge_ip_addr: string }).edge_ip_addr = '198.51.100.55'; // a genuine third party
    const m = snap(streams).monitors.find((x) => x.streamKey === 's-mislabelled')!;
    const split = m.warnings.find((w) => w.kind === 'attribution_split');
    expect(split).toBeDefined();
    expect(split!.message).toContain('1 of 2 probes');
    expect(m.warnings.some((w) => w.kind === 'attribution_mismatch')).toBe(false);
    const s = snap(streams).summary;
    expect(s.attributionSplitCount).toBe(1);
    expect(s.attributionMismatchCount).toBe(0);
  });

  it('does not flag a third-party label served from third-party edges', () => {
    const s = snap();
    const fastly = s.monitors.find((x) => x.platformClaimed === 'Fastly')!;
    expect(fastly.warnings.some((w) => w.kind === 'attribution_mismatch')).toBe(false);
  });

  it('flags the reverse — an own-CDN label never served from an owned prefix', () => {
    const streams = structuredClone(STREAMS_NORMAL);
    const own = streams.find((x) => x.stream_key === 's-own-mpd')!;
    for (const v of own.location_detail!) (v as { edge_ip_addr: string }).edge_ip_addr = '198.51.100.77';
    const m = snap(streams).monitors.find((x) => x.streamKey === 's-own-mpd')!;
    expect(m.warnings.some((w) => w.kind === 'attribution_mismatch')).toBe(true);
  });

  it('stays silent when the edges cannot be evaluated (IPv6) rather than guessing', () => {
    const streams = structuredClone(STREAMS_NORMAL);
    const own = streams.find((x) => x.stream_key === 's-own-mpd')!;
    for (const v of own.location_detail!) (v as { edge_ip_addr: string }).edge_ip_addr = '2a00:1ed8::1';
    const m = snap(streams).monitors.find((x) => x.streamKey === 's-own-mpd')!;
    expect(m.warnings.some((w) => w.kind === 'attribution_mismatch')).toBe(false);
  });
});

describe('comparability (the probe-asymmetry finding)', () => {
  it('marks a row incomparable when no probe location is shared by every CDN', () => {
    const s = snap(STREAMS_INCOMPARABLE);
    const row = s.rows[0];
    expect(row.comparability.comparable).toBe(false);
    expect(row.comparability.headlineComparable).toBe(false);
    expect(row.comparability.sharedLocations).toEqual([]);
    expect(row.comparability.reason).toContain('no like-for-like comparison exists');
    expect(s.summary.incomparableRowCount).toBe(1);
    // With nothing shared there is no fair figure to offer.
    for (const c of row.cells) expect(c.sharedSpeed).toBeNull();
  });

  it('marks a row comparable and names the shared locations when probes overlap', () => {
    const row = snap().rows.find((r) => r.format === 'MPD')!;
    expect(row.comparability.comparable).toBe(true);
    expect(row.comparability.headlineComparable).toBe(true); // identical location sets
    expect(row.comparability.sharedLocations).toEqual(['GB-LND-AWS', 'IE-D-AWS']);
  });

  it('separates "a fair comparison exists" from "the headline figures are fair"', () => {
    // The live RTE 1 shape: every CDN shares one location, but they otherwise probe different
    // places — so a like-for-like comparison IS available, just not the headline averages.
    const streams = structuredClone(STREAMS_NORMAL).filter((x) => x.channel === 'Channel One' && x.format === 'MPD');
    // Give Fastly one shared location plus one of its own.
    const fastly = streams.find((x) => x.stream_key === 's-fastly-mpd')!;
    fastly.location_detail = [fastly.location_detail![0], { ...fastly.location_detail![1], location: 'FR-IDF-AWS' }];
    const row = snap(streams).rows[0];
    expect(row.comparability.comparable).toBe(true);
    expect(row.comparability.headlineComparable).toBe(false);
    expect(row.comparability.sharedLocations).toEqual(['IE-D-AWS']);
    expect(row.comparability.reason).toContain('compare them at IE-D-AWS');
    // The fair figure is the average over the shared location only…
    const own = row.cells.find((c) => c.platform === 'Réalta')!;
    expect(own.sharedLocationCount).toBe(1);
    expect(own.sharedSpeed).toBe(0.2);
    // …and the locations that cannot be compared are named, which is how "no Irish probe on this
    // CDN" becomes visible.
    expect(row.cells.find((c) => c.platform === 'Fastly')!.unsharedLocations).toEqual(['FR-IDF-AWS']);
  });

  it('treats a single monitored platform as comparable — there is nothing to compare', () => {
    const cell = (platform: 'Réalta', locations: string[]): TouchstreamCell => ({
      platform,
      cdnLabel: 'RTE CDN',
      monitor: { vantages: locations.map((l) => ({ location: l })), cdnLabel: 'RTE CDN' } as TouchstreamMonitor,
      sharedSpeed: null,
      sharedLocationCount: 0,
      unsharedLocations: [],
    });
    const verdict = comparabilityOf([
      cell('Réalta', ['IE-D-AWS']),
      { platform: 'Fastly', cdnLabel: null, monitor: null, sharedSpeed: null, sharedLocationCount: 0, unsharedLocations: [] },
    ]);
    expect(verdict.comparable).toBe(true);
    expect(verdict.reason).toBeNull();
  });
});

describe('vantages and renditions', () => {
  it('resolves probe geography and edge ownership per location', () => {
    const m = snap().monitors.find((x) => x.streamKey === 's-own-mpd')!;
    const dublin = m.vantages.find((v) => v.location === 'IE-D-AWS')!;
    expect(dublin).toMatchObject({ country: 'Ireland', region: 'Dublin', edgeIsRteOwned: true });
    expect(dublin.renditions.length).toBeGreaterThan(0);
  });

  it('surfaces a stalled rendition as a warning', () => {
    const m = snap(STREAMS_DEGRADED).monitors.find((x) => x.streamKey === 's-fastly-mpd')!;
    expect(m.warnings.some((w) => w.kind === 'stalled_rendition')).toBe(true);
  });

  it('does not treat a planned outage as a fault', () => {
    const s = snap(STREAMS_DEGRADED);
    const outage = s.monitors.find((x) => x.plannedOutage)!;
    expect(outage.warnings.some((w) => w.kind === 'planned_outage')).toBe(true);
    expect(s.summary.failingCount).toBe(1); // the Fastly failure only, not the outage
  });
});

describe('windowed history', () => {
  it('maps stats and errors, orders errors newest-first and reports truncation', () => {
    const h = buildHistory({ stats: STATS, errors: ERRORS, fromMs: 1_000, toMs: 2_000, environment: 'PROD', maxErrors: 1 });
    expect(h.stats[0].platform).toBe('Réalta');
    expect(h.stats.map((s) => s.cdnLabel)).toContain('FASTLY');
    expect(h.errors).toHaveLength(1);
    expect(h.truncated).toBe(true);
    expect(h.errors[0].platform).toBe('Fastly');
    expect(h.errors[0].statusCode).toBe('500');
  });
});

describe('config', () => {
  it('defaults to disabled mock mode with the RTÉ prefixes', () => {
    const c = loadTouchstreamConfig({});
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('mock');
    expect(c.ownedPrefixes).toEqual(DEFAULT_OWNED_PREFIXES);
  });

  it('requires BOTH credentials in live mode and says why', () => {
    expect(() =>
      loadTouchstreamConfig({ TOUCHSTREAM_ENABLED: 'true', TOUCHSTREAM_MODE: 'live', TOUCHSTREAM_ENDPOINT: 'https://x', TOUCHSTREAM_APP_ID: 'id' }),
    ).toThrow(TouchstreamConfigError);
    try {
      loadTouchstreamConfig({ TOUCHSTREAM_ENABLED: 'true', TOUCHSTREAM_MODE: 'live', TOUCHSTREAM_ENDPOINT: 'https://x', TOUCHSTREAM_APP_ID: 'id' });
    } catch (err) {
      expect((err as Error).message).toContain('TOUCHSTREAM_TOKEN');
      expect((err as Error).message).toContain('403');
    }
  });

  it('accepts a fully configured live connector and trims the endpoint', () => {
    const c = loadTouchstreamConfig({
      TOUCHSTREAM_ENABLED: 'true',
      TOUCHSTREAM_MODE: 'live',
      TOUCHSTREAM_ENDPOINT: 'https://tsi.example.net/',
      TOUCHSTREAM_APP_ID: 'app',
      TOUCHSTREAM_TOKEN: 'tok',
    });
    expect(c.endpoint).toBe('https://tsi.example.net');
    expect(c.appId).toBe('app');
  });

  it('mock mode needs no credentials', () => {
    const c = loadTouchstreamConfig({ TOUCHSTREAM_ENABLED: 'true', TOUCHSTREAM_MODE: 'mock' });
    expect(c.enabled).toBe(true);
    expect(c.appId).toBeUndefined();
  });
});

describe('mock client', () => {
  it('serves each scenario and raises a typed auth error', async () => {
    expect(await new MockTouchstreamClient().fetchStreams()).toHaveLength(STREAMS_NORMAL.length);
    expect(await new MockTouchstreamClient({ scenario: 'empty' }).fetchStreams()).toEqual([]);
    await expect(new MockTouchstreamClient({ scenario: 'auth-failure' }).fetchStreams()).rejects.toMatchObject({
      code: 'TOUCHSTREAM_AUTH',
      upstreamStatus: 403,
    });
    await expect(new MockTouchstreamClient({ scenario: 'unavailable' }).fetchLocationGroups()).rejects.toMatchObject({
      code: 'TOUCHSTREAM_UNAVAILABLE',
    });
  });
});

// RTÉ channel entitlement resolver. Ties the public mpx feeds + SMIL resolve + redirect chain into a
// single "channel → discovered manifest" step, so Stream Tests can be pointed at a CHANNEL and figure
// out the (IP-signed-for-us) manifest and the CDN objects to probe. All hops are SSRF-guarded and
// fetched from RADAR's own IP — so the CDN token is minted for RADAR, sidestepping the client IP-lock.
//
// Chain (see rte-streaming-topology): station feed → mediaPid (listings, byCallSign) →
//   link.eu.theplatform.com SMIL resolve → signed entry manifest URL → follow redirects
//   (DAI create → DAI session for DAI channels; direct for the rest) → discover segments.
import { streamAssurance as sa } from '@radar/engine';
import { fetchFollowingRedirects } from './follow.js';
import type { SsrfPolicy } from './ssrf.js';

export interface RteFeedConfig {
  feedHost: string;   // e.g. feed.entertainment.tv.theplatform.eu
  smilHost: string;   // e.g. link.eu.theplatform.com
  account: string;    // mpx account PID, e.g. 1uC-gC
  stationFeed: string;    // e.g. rte-prd-isl-all-stations
  schedulesFeed: string;  // e.g. rte-prd-prd-all-schedules (supports byCallSign; listings carry mediaPid)
}

export const DEFAULT_RTE_FEED_CONFIG: RteFeedConfig = {
  feedHost: 'feed.entertainment.tv.theplatform.eu',
  smilHost: 'link.eu.theplatform.com',
  account: '1uC-gC',
  stationFeed: 'rte-prd-isl-all-stations',
  schedulesFeed: 'rte-prd-prd-all-schedules',
};

export interface RteChannel {
  guid: string;
  title: string;
  callSign: string;
  isVirtual: boolean;
  /** Google DAI DASH asset key when the channel is server-side ad-inserted; null for direct-CDN channels. */
  daiKey: string | null;
  delivery: 'dai' | 'direct';
}

export interface ResolvedChannel {
  callSign: string;
  mediaPid: string;
  /** The signed manifest URL from the SMIL (may be a tokenised DAI entry that redirects). */
  entryUrl: string;
  /** The manifest URL that actually returned the MPD (after following redirects). */
  finalManifestUrl: string;
  redirects: string[];
  adTags: string[];
  manifest: sa.DiscoveredManifest;
}

const FEED_MAX = 4 * 1024 * 1024;

async function getJson(url: string, policy: SsrfPolicy): Promise<unknown> {
  const res = await fetchFollowingRedirects(url, policy, { maxBytes: FEED_MAX, headers: { accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`feed ${url} returned HTTP ${res.status}`);
  return JSON.parse(Buffer.from(res.body).toString('utf8'));
}

/** List the RTÉ live channels from the mpx station feed (public). */
export async function listRteChannels(cfg: RteFeedConfig, policy: SsrfPolicy): Promise<RteChannel[]> {
  const url = `https://${cfg.feedHost}/f/${cfg.account}/${cfg.stationFeed}?schema=2.15`;
  const j = getEntries(await getJson(url, policy));
  return j.map((e) => {
    const callSign = str(e['plstation$callSign']) ?? str(e['guid']) ?? '';
    const daiKey = str(e['rte$google-ssai-dash']);
    return {
      guid: str(e['guid']) ?? callSign,
      title: str(e['description']) ?? str(e['title']) ?? callSign,
      callSign,
      isVirtual: e['plstation$isVirtual'] === true,
      daiKey,
      delivery: daiKey ? 'dai' : 'direct',
    } as RteChannel;
  }).filter((c) => c.callSign);
}

/** The currently-airing listing's mediaPid for a channel, from the schedules feed (the live media). */
export async function resolveMediaPid(callSign: string, cfg: RteFeedConfig, policy: SsrfPolicy, nowMs: number): Promise<string | null> {
  // The schedules feed supports byCallSign; a zero-width time window still returns a small window of
  // listings, so pick the one actually airing at `nowMs` (fall back to the first with a mediaPid).
  const url = `https://${cfg.feedHost}/f/${cfg.account}/${cfg.schedulesFeed}?byCallSign=${encodeURIComponent(callSign)}&byListingTime=${nowMs}~${nowMs}`;
  const listings: Record<string, unknown>[] = [];
  for (const e of getEntries(await getJson(url, policy))) {
    const ls = e['plchannelschedule$listings'];
    if (Array.isArray(ls)) listings.push(...(ls as Record<string, unknown>[]));
  }
  const airingNow = listings.find((l) => {
    const s = Number(l['pllisting$startTime']); const en = Number(l['pllisting$endTime']);
    return Number.isFinite(s) && Number.isFinite(en) && s <= nowMs && nowMs < en;
  });
  return str(airingNow?.['rtelisting$mediaPid']) ?? str(listings.find((l) => str(l['rtelisting$mediaPid']))?.['rtelisting$mediaPid']);
}

/** Resolve a channel end-to-end: mediaPid → SMIL → follow redirects → discover the CDN objects. */
export async function resolveChannel(callSign: string, cfg: RteFeedConfig, policy: SsrfPolicy, nowMs: number): Promise<ResolvedChannel> {
  const mediaPid = await resolveMediaPid(callSign, cfg, policy, nowMs);
  if (!mediaPid) throw new Error(`no current media (mediaPid) for channel '${callSign}'`);

  const smilUrl = `https://${cfg.smilHost}/s/${cfg.account}/media/${mediaPid}?format=SMIL&formats=mpeg-dash`;
  const smilRes = await fetchFollowingRedirects(smilUrl, policy, { maxBytes: FEED_MAX });
  if (smilRes.status < 200 || smilRes.status >= 300) throw new Error(`SMIL resolve returned HTTP ${smilRes.status}`);
  const smil = sa.parseSmil(Buffer.from(smilRes.body).toString('utf8'));
  if (!smil.dashManifestUrl) throw new Error('SMIL contained no DASH manifest URL');

  // The entry URL may be a tokenised DAI entry that redirects to the session manifest.
  const manifestRes = await fetchFollowingRedirects(smil.dashManifestUrl, policy, { maxBytes: FEED_MAX });
  if (manifestRes.status < 200 || manifestRes.status >= 300) throw new Error(`manifest fetch returned HTTP ${manifestRes.status}`);
  const manifest = sa.discoverDashSegments(Buffer.from(manifestRes.body).toString('utf8'), manifestRes.finalUrl);

  return {
    callSign, mediaPid,
    entryUrl: smil.dashManifestUrl,
    finalManifestUrl: manifestRes.finalUrl,
    redirects: manifestRes.redirects,
    adTags: smil.adTags,
    manifest,
  };
}

// --- small helpers for the loosely-typed feed JSON ---
function getEntries(j: unknown): Record<string, unknown>[] {
  const entries = (j as { entries?: unknown })?.entries;
  return Array.isArray(entries) ? (entries as Record<string, unknown>[]) : [];
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

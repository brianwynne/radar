// Manifest observation: fetch a profile's DASH MPD and/or HLS playlists via the SSRF-guarded
// connect-to probe (preserving the public URL/SNI/Host), parse + validate them with the pure
// @radar/engine, and run the DASH↔HLS cross-protocol comparison. Returns manifest-level SpecFindings
// the service folds into a run. Bounded fetches; never retrieves an encryption key.
import { streamAssurance as sa } from '@radar/engine';
import { probe } from './probe.js';
import { validateTarget, type SsrfPolicy } from './ssrf.js';

export interface ManifestSources {
  dashMpdUrl?: string;
  hlsMasterUrl?: string;
  hlsMediaUrl?: string;
  /** A recent media fragment (CMAF segment) URL, sampled per-CDN for cross-CDN timeline drift. */
  mediaFragmentUrl?: string;
}

// A media fragment's moof (mfhd/tfdt/trun) sits at the front, before mdat; a modest cap captures the
// timeline signalling without downloading the whole (potentially multi-MB) segment.
const FRAGMENT_MAX_BYTES = 512 * 1024;

export interface ManifestFetchContext {
  connectHost: string;
  connectPort?: number;
  hostHeader?: string;
  sni?: string;
  managedInternal?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Outcome of one manifest/fragment fetch — status/error kept so the UI can explain "unreachable". */
export interface FetchOutcome { status: number | null; error: string | null }

const fetchText = async (url: string, ctx: ManifestFetchContext): Promise<{ text: string | null; outcome: FetchOutcome }> => {
  try {
    const res = await probe({ publicUrl: url, connectHost: ctx.connectHost, connectPort: ctx.connectPort, hostHeader: ctx.hostHeader, sni: ctx.sni, timeoutMs: ctx.timeoutMs, maxBytes: ctx.maxBytes ?? 4 * 1024 * 1024 });
    const text = res.status >= 200 && res.status < 300 ? Buffer.from(res.body).toString('utf8') : null;
    return { text, outcome: { status: res.status, error: null } };
  } catch (e) {
    return { text: null, outcome: { status: null, error: e instanceof Error ? e.message : String(e) } };
  }
};

const fetchFragment = async (url: string, ctx: ManifestFetchContext): Promise<{ fragment: sa.FragmentInfo | null; outcome: FetchOutcome }> => {
  try {
    const res = await probe({ publicUrl: url, connectHost: ctx.connectHost, connectPort: ctx.connectPort, hostHeader: ctx.hostHeader, sni: ctx.sni, timeoutMs: ctx.timeoutMs, maxBytes: FRAGMENT_MAX_BYTES });
    if (res.status < 200 || res.status >= 300) return { fragment: null, outcome: { status: res.status, error: null } };
    const bytes = new Uint8Array(res.body);
    return { fragment: sa.analyseMediaFragment(bytes, sa.parseBoxes(bytes).boxes), outcome: { status: res.status, error: null } };
  } catch (e) {
    return { fragment: null, outcome: { status: null, error: e instanceof Error ? e.message : String(e) } };
  }
};

/** Parsed manifest summary for one endpoint — fed to the cross-CDN consistency comparison. */
export interface ManifestObservation {
  findings: sa.SpecFinding[];
  dash: sa.DashManifestInfo | null;
  hlsMaster: sa.HlsMaster | null;
  fragment: sa.FragmentInfo | null;
  /** Per-source fetch outcomes (status/error) so the UI can explain a failed check. */
  fetch: { dash: FetchOutcome | null; hlsMaster: FetchOutcome | null; fragment: FetchOutcome | null };
}

/** Fetch + validate the configured manifests for ONE endpoint and cross-compare DASH vs HLS. Returns
 *  the per-endpoint SpecFindings plus the parsed manifests (for cross-CDN comparison by the caller). */
export async function observeManifests(sources: ManifestSources, ctx: ManifestFetchContext, policy: SsrfPolicy, nowMs: number): Promise<ManifestObservation> {
  if (!validateTarget({ connectHost: ctx.connectHost, managedInternal: ctx.managedInternal }, policy).ok) {
    return { findings: [], dash: null, hlsMaster: null, fragment: null, fetch: { dash: null, hlsMaster: null, fragment: null } };
  }
  const findings: sa.SpecFinding[] = [];

  const dashRes = sources.dashMpdUrl ? await fetchText(sources.dashMpdUrl, ctx) : null;
  const hlsMasterRes = sources.hlsMasterUrl ? await fetchText(sources.hlsMasterUrl, ctx) : null;
  const hlsMediaRes = sources.hlsMediaUrl ? await fetchText(sources.hlsMediaUrl, ctx) : null;
  const dashText = dashRes?.text ?? null;
  const hlsMasterText = hlsMasterRes?.text ?? null;
  const hlsMediaText = hlsMediaRes?.text ?? null;

  const dash = dashText ? sa.extractDashManifest(dashText) : null;
  if (dash) findings.push(...sa.validateDashFreshness(dash, nowMs));
  const hlsMaster = hlsMasterText ? sa.parseMasterPlaylist(hlsMasterText) : null;
  if (hlsMaster) findings.push(...sa.validateMaster(hlsMaster));
  const hlsMedia = hlsMediaText ? sa.parseMediaPlaylist(hlsMediaText) : null;
  if (hlsMedia) findings.push(...sa.validateMedia(hlsMedia));

  // Cross-protocol: only when both protocols are available.
  if (dash && (hlsMedia || hlsMaster)) {
    findings.push(...sa.compareDashHls({
      dashDefaultKid: dash.drm.defaultKid,
      dashSystems: dash.drm.systems.map((s) => s.systemId),
      dashLive: dash.presentation === 'dynamic',
      hlsKeyFormats: (hlsMedia?.keys ?? []).map((k) => k.keyFormat).filter((f): f is string => !!f),
      hlsLive: hlsMedia ? !hlsMedia.endList : null,
      hlsCodecs: (hlsMaster?.variants ?? []).flatMap((v) => v.codecs),
    }));
  }
  const fragRes = sources.mediaFragmentUrl ? await fetchFragment(sources.mediaFragmentUrl, ctx) : null;
  return {
    findings, dash, hlsMaster, fragment: fragRes?.fragment ?? null,
    fetch: { dash: dashRes?.outcome ?? null, hlsMaster: hlsMasterRes?.outcome ?? null, fragment: fragRes?.outcome ?? null },
  };
}

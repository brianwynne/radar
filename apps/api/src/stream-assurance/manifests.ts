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
}

export interface ManifestFetchContext {
  connectHost: string;
  connectPort?: number;
  hostHeader?: string;
  sni?: string;
  managedInternal?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

const fetchText = async (url: string, ctx: ManifestFetchContext): Promise<string | null> => {
  try {
    const res = await probe({ publicUrl: url, connectHost: ctx.connectHost, connectPort: ctx.connectPort, hostHeader: ctx.hostHeader, sni: ctx.sni, timeoutMs: ctx.timeoutMs, maxBytes: ctx.maxBytes ?? 4 * 1024 * 1024 });
    if (res.status < 200 || res.status >= 300) return null;
    return Buffer.from(res.body).toString('utf8');
  } catch {
    return null;
  }
};

/** Parsed manifest summary for one endpoint — fed to the cross-CDN consistency comparison. */
export interface ManifestObservation {
  findings: sa.SpecFinding[];
  dash: sa.DashManifestInfo | null;
  hlsMaster: sa.HlsMaster | null;
}

/** Fetch + validate the configured manifests for ONE endpoint and cross-compare DASH vs HLS. Returns
 *  the per-endpoint SpecFindings plus the parsed manifests (for cross-CDN comparison by the caller). */
export async function observeManifests(sources: ManifestSources, ctx: ManifestFetchContext, policy: SsrfPolicy, nowMs: number): Promise<ManifestObservation> {
  if (!validateTarget({ connectHost: ctx.connectHost, managedInternal: ctx.managedInternal }, policy).ok) return { findings: [], dash: null, hlsMaster: null };
  const findings: sa.SpecFinding[] = [];

  const dashText = sources.dashMpdUrl ? await fetchText(sources.dashMpdUrl, ctx) : null;
  const hlsMasterText = sources.hlsMasterUrl ? await fetchText(sources.hlsMasterUrl, ctx) : null;
  const hlsMediaText = sources.hlsMediaUrl ? await fetchText(sources.hlsMediaUrl, ctx) : null;

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
  return { findings, dash, hlsMaster };
}

// Cross-CDN manifest consistency. Given the SAME manifest fetched through several CDNs (same public
// URL, different connect-to target), decide whether every CDN is serving the same manifest
// generation. Drift here means one CDN cached an older/other manifest — a client pinned to that CDN
// sees a different key generation, a different bitrate ladder, or a lagging live edge. Pure, no I/O.
//
// Expected value comes from the configured reference endpoint (or the first that has the manifest);
// candidates are compared against it — never a majority vote.
import type { CdnKind } from './cdn-headers.js';
import type { DashManifestInfo } from './dash.js';
import type { HlsMaster } from './hls.js';
import type { Finding, Layer } from './classify.js';
import { rule } from './rules.js';

export interface EndpointManifest {
  endpointId: string;
  provider: CdnKind;
  role: 'reference' | 'candidate';
  dash: DashManifestInfo | null;
  hlsMaster: HlsMaster | null;
}

export interface ManifestConsistencyOptions {
  /** Publish-time skew (seconds) between CDNs that is tolerated before SA-XCDN-003 fires. */
  publishTimeSkewSeconds?: number;
}

const norm = (s: string | null | undefined): string | null => (s ? s.toLowerCase() : null);
const ladderKey = (xs: number[]): string => xs.join(',');

/** Compare the same manifest served through multiple CDNs; flag KID / ladder / freshness drift. */
export function compareManifestsAcrossCdns(manifests: EndpointManifest[], opts: ManifestConsistencyOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const skewTolerance = opts.publishTimeSkewSeconds ?? 30;

  // --- DASH ---
  const withDash = manifests.filter((m) => m.dash);
  const dashRef = withDash.find((m) => m.role === 'reference') ?? withDash[0];
  if (dashRef?.dash) {
    const ref = dashRef.dash;
    const refKid = norm(ref.drm.defaultKid);
    const refLadder = ladderKey(ref.representationBandwidths);
    const refPublish = ref.publishTime ? Date.parse(ref.publishTime) : NaN;
    for (const m of withDash) {
      if (m.endpointId === dashRef.endpointId || !m.dash) continue;
      const d = m.dash;
      const kid = norm(d.drm.defaultKid);
      if (refKid && kid && kid !== refKid) {
        const r = rule('SA-XCDN-001');
        findings.push(mk(r.id, 'DRM_KID_MISMATCH', r.severity, m, 'dash', 'edge',
          `${m.provider} advertises default_KID ${kid} in its MPD where ${dashRef.provider} (reference) advertises ${refKid} — this CDN is serving a manifest from a different key generation.`,
          r.remediation, { manifestKid: kid, referenceKid: refKid, referenceEndpoint: dashRef.endpointId }));
      }
      if (refLadder && d.representationBandwidths.length && ladderKey(d.representationBandwidths) !== refLadder) {
        const r = rule('SA-XCDN-002');
        findings.push(mk(r.id, 'REPRESENTATION_DRIFT', r.severity, m, 'dash', 'edge',
          `${m.provider} advertises a different DASH bitrate ladder (${d.representationBandwidths.join(', ') || 'none'}) than ${dashRef.provider} (${ref.representationBandwidths.join(', ')}).`,
          r.remediation, { ladder: d.representationBandwidths, referenceLadder: ref.representationBandwidths, referenceEndpoint: dashRef.endpointId }));
      }
      if (ref.presentation === 'dynamic' && Number.isFinite(refPublish) && d.publishTime) {
        const t = Date.parse(d.publishTime);
        const skew = Number.isFinite(t) ? Math.round((refPublish - t) / 1000) : null;
        if (skew != null && Math.abs(skew) > skewTolerance) {
          const r = rule('SA-XCDN-003');
          findings.push(mk(r.id, 'MANIFEST_STALE', r.severity, m, 'dash', 'edge',
            `${m.provider}'s live MPD publishTime is ${Math.abs(skew)}s ${skew > 0 ? 'behind' : 'ahead of'} ${dashRef.provider} (reference) — this CDN is serving an out-of-step manifest generation.`,
            r.remediation, { publishTime: d.publishTime, referencePublishTime: ref.publishTime, skewSeconds: skew, referenceEndpoint: dashRef.endpointId }));
        }
      }
    }
  }

  // --- HLS master (bitrate ladder) ---
  const withHls = manifests.filter((m) => m.hlsMaster);
  const hlsRef = withHls.find((m) => m.role === 'reference') ?? withHls[0];
  if (hlsRef?.hlsMaster) {
    const refBands = hlsRef.hlsMaster.variants.map((v) => v.bandwidth ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
    const refLadder = ladderKey(refBands);
    for (const m of withHls) {
      if (m.endpointId === hlsRef.endpointId || !m.hlsMaster) continue;
      const bands = m.hlsMaster.variants.map((v) => v.bandwidth ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
      if (refLadder && bands.length && ladderKey(bands) !== refLadder) {
        const r = rule('SA-XCDN-002');
        findings.push(mk(r.id, 'REPRESENTATION_DRIFT', r.severity, m, 'hls', 'edge',
          `${m.provider} advertises a different HLS variant ladder (${bands.join(', ') || 'none'}) than ${hlsRef.provider} (${refBands.join(', ')}).`,
          r.remediation, { ladder: bands, referenceLadder: refBands, referenceEndpoint: hlsRef.endpointId }));
      }
    }
  }

  return findings;
}

function mk(ruleId: string, classification: Finding['classification'], severity: Finding['severity'], m: EndpointManifest, protocol: Finding['protocol'], likelyLayer: Layer, explanation: string, remediation: string, evidence: Record<string, unknown>): Finding {
  return { ruleId, classification, severity, endpointId: m.endpointId, provider: m.provider, protocol, likelyLayer, explanation, remediation, evidence };
}

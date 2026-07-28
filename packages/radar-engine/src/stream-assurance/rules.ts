// Rule catalogue for Stream Conformance & CDN Consistency. Each rule has a stable identifier, a
// severity, the standard/profile it derives from (with a section reference where known) and a
// concise, ORIGINAL explanation + remediation. No copyrighted standards text is reproduced. The
// catalogue is data so profiles/rule versions can change without touching the engine.

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export type Protocol = 'dash' | 'hls' | 'cmaf' | 'cenc' | 'crossproto';

/** A standards/structural finding without endpoint context (manifest-level validation). Adapt to a
 *  cross-CDN `Finding` with `withEndpoint()` when attaching to a specific endpoint's run. */
export interface SpecFinding {
  ruleId: string;
  classification: Classification;
  severity: Severity;
  protocol: Protocol;
  explanation: string;
  remediation: string;
  evidence: Record<string, unknown>;
}

export type Classification =
  | 'CDN_EDGE_STALE'
  | 'CDN_SHIELD_STALE'
  | 'ORIGIN_VARIANT_MISMATCH'
  | 'DRM_KID_MISMATCH'
  | 'MANIFEST_INIT_MISMATCH'
  | 'INIT_MEDIA_MISMATCH'
  | 'DASH_HLS_MISMATCH'
  | 'MANIFEST_STALE'
  | 'TIMELINE_GAP'
  | 'TIMELINE_OVERLAP'
  | 'REPRESENTATION_DRIFT'
  | 'ORIGIN_IDENTITY_DRIFT'
  | 'CACHE_POLICY_DRIFT'
  | 'UNREACHABLE_OBJECT'
  | 'SPEC_CONFORMANCE_ERROR';

export interface Rule {
  id: string;
  severity: Severity;
  /** Standard/profile family this rule derives from. */
  standard: string;
  /** Section reference within the standard, where known (else null). */
  section: string | null;
  /** Concise, original description of what the rule checks. */
  description: string;
  /** Operator-facing remediation guidance. */
  remediation: string;
}

export const RULES: Record<string, Rule> = {
  'SA-CENC-001': {
    id: 'SA-CENC-001', severity: 'critical', standard: 'ISO/IEC 23001-7 (CENC) + DASH-IF', section: 'tenc / ContentProtection',
    description: 'The default_KID advertised by the MPD ContentProtection element does not match the default_KID in the initialisation segment tenc box.',
    remediation: 'Re-publish so the packager MPD and the init segment reference the same default_KID; verify the CDN is not serving a stale or wrong-variant init object.',
  },
  'SA-CENC-002': {
    id: 'SA-CENC-002', severity: 'critical', standard: 'ISO/IEC 23001-7 (CENC)', section: 'tenc',
    description: 'The default_KID differs between CDN endpoints for the same logical initialisation object.',
    remediation: 'Identify the responsible tier (edge / shield / origin) from the cache evidence and correct it; align origin selection and forwarded Host so every CDN pulls the same object.',
  },
  'SA-CENC-003': {
    id: 'SA-CENC-003', severity: 'error', standard: 'ISO/IEC 23001-7 (CENC)', section: 'schm / tenc',
    description: 'Protection scheme or per-sample IV size is inconsistent across representations or endpoints.',
    remediation: 'Ensure a single, consistent encryption scheme (e.g. cbcs) and IV configuration across the ladder and all CDNs.',
  },
  'SA-CENC-004': {
    id: 'SA-CENC-004', severity: 'error', standard: 'ISO/IEC 23001-7 (CENC)', section: 'pssh',
    description: 'Declared DRM systems (MPD/HLS) do not match the PSSH system IDs present in the initialisation segment.',
    remediation: 'Regenerate PSSH for the expected DRM systems, or correct the manifest DRM declarations to match the packaged systems.',
  },
  'SA-CDN-001': {
    id: 'SA-CDN-001', severity: 'critical', standard: 'RADAR delivery consistency', section: null,
    description: 'A CDN returned a different/older object than the reference, and its edge AND parent tiers both reported cache misses — the object came from origin, indicating an origin-side variant or origin-selection (forwarded Host) problem rather than a stale CDN cache.',
    remediation: 'Align the CDN forwarded Host header with the origin hostname and confirm origin selection; the fault is at origin/config, so purging CDN caches alone will not fix it.',
  },
  'SA-CDN-002': {
    id: 'SA-CDN-002', severity: 'error', standard: 'RADAR delivery consistency', section: null,
    description: 'A CDN edge served a stale object (edge cache HIT) while newer content is available.',
    remediation: 'Purge/invalidate the edge object or shorten its TTL; verify cache-key configuration.',
  },
  'SA-CDN-003': {
    id: 'SA-CDN-003', severity: 'error', standard: 'RADAR delivery consistency', section: null,
    description: 'A CDN parent/shield served a stale object (edge MISS, parent HIT) while newer content is available.',
    remediation: 'Purge the shield tier and verify shield TTL/cache-key; edge revalidation alone will not refresh it.',
  },
  'SA-CDN-004': {
    id: 'SA-CDN-004', severity: 'warning', standard: 'RADAR delivery consistency', section: null,
    description: 'The origin identity differs between CDNs for the same object, indicating divergent origin selection.',
    remediation: 'Confirm all CDNs are configured against the same origin and forward a consistent Host header.',
  },
  'SA-CDN-005': {
    id: 'SA-CDN-005', severity: 'warning', standard: 'HTTP caching (RFC 9111)', section: null,
    description: 'Cache-Control / freshness policy differs materially between CDNs for the same object.',
    remediation: 'Normalise cache policy so all CDNs age and revalidate the object consistently.',
  },
  'SA-DASH-001': {
    id: 'SA-DASH-001', severity: 'error', standard: 'ISO/IEC 23009-1 (MPD)', section: 'MPD@publishTime',
    description: 'The DASH manifest is stale — its publication time / update period indicates it has not refreshed within the expected window.',
    remediation: 'Check the packager and the CDN manifest TTL; a live MPD must refresh within minimumUpdatePeriod.',
  },
  'SA-HLS-001': {
    id: 'SA-HLS-001', severity: 'error', standard: 'RFC 8216 (HLS)', section: 'EXT-X-MEDIA-SEQUENCE',
    description: 'The HLS media playlist timeline regressed or stalled — the media sequence did not advance as expected for a live stream.',
    remediation: 'Verify the packager output and CDN playlist TTL; a live media playlist must advance monotonically.',
  },
  'SA-HLS-002': {
    id: 'SA-HLS-002', severity: 'error', standard: 'RFC 8216 (HLS)', section: 'EXT-X-STREAM-INF / EXT-X-MEDIA',
    description: 'The HLS master playlist is non-conformant — missing #EXTM3U, a variant without BANDWIDTH/CODECS, a duplicate variant, or a rendition group referenced by a variant but not defined.',
    remediation: 'Correct the master playlist so every variant declares BANDWIDTH and CODECS and every referenced AUDIO/SUBTITLES group exists.',
  },
  'SA-HLS-003': {
    id: 'SA-HLS-003', severity: 'warning', standard: 'RFC 8216 (HLS)', section: 'EXT-X-TARGETDURATION / EXTINF',
    description: 'A media playlist segment duration exceeds the declared EXT-X-TARGETDURATION, or a VOD playlist is missing EXT-X-ENDLIST, or PROGRAM-DATE-TIME is not monotonically increasing.',
    remediation: 'Ensure EXTINF durations round within EXT-X-TARGETDURATION, VOD playlists end with EXT-X-ENDLIST, and PROGRAM-DATE-TIME advances monotonically.',
  },
  'SA-HLS-004': {
    id: 'SA-HLS-004', severity: 'error', standard: 'RFC 8216 (HLS) + CMAF', section: 'EXT-X-KEY',
    description: 'The HLS encryption signalling is inconsistent — an EXT-X-KEY without a URI, a missing KEYFORMAT for a DRM method, or an encryption method that disagrees with the CMAF content.',
    remediation: 'Correct EXT-X-KEY so METHOD, KEYFORMAT and URI are present and consistent with the packaged CMAF protection scheme. (RADAR never retrieves the key.)',
  },
  'SA-XDRM-001': {
    id: 'SA-XDRM-001', severity: 'critical', standard: 'DASH-IF / Apple HLS interop', section: null,
    description: 'DASH and HLS advertise different encryption identity (KID / DRM systems) for the same service.',
    remediation: 'Re-package so both protocols reference the same key identity; check that both are served from the same origin object set.',
  },
  'SA-XDRM-002': {
    id: 'SA-XDRM-002', severity: 'error', standard: 'DASH-IF / Apple HLS interop', section: null,
    description: 'DASH and HLS advertise a different codec set or presentation mode (live vs static) for the same service.',
    remediation: 'Align the DASH and HLS packaging so both advertise the same codecs and the same live/VOD mode.',
  },
  'SA-OBJ-001': {
    id: 'SA-OBJ-001', severity: 'error', standard: 'RADAR delivery consistency', section: null,
    description: 'A selected initialisation or recent media object was unreachable within the configured timeout.',
    remediation: 'Check endpoint availability, origin health and the resolved segment URL template.',
  },
};

export const rule = (id: string): Rule => {
  const r = RULES[id];
  if (!r) throw new Error(`unknown rule id: ${id}`);
  return r;
};

export const listRules = (): Rule[] => Object.values(RULES);

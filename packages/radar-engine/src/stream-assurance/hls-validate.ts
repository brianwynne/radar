// HLS conformance validators over parsed playlists (RFC 8216 + Apple authoring). Returns manifest-
// level SpecFindings — structure, timeline and encryption SIGNALLING only (no key retrieval).
import type { HlsMaster, HlsMedia } from './hls.js';
import type { SpecFinding } from './rules.js';

const finding = (ruleId: string, severity: SpecFinding['severity'], explanation: string, remediation: string, evidence: Record<string, unknown>): SpecFinding =>
  ({ ruleId, classification: 'SPEC_CONFORMANCE_ERROR', severity, protocol: 'hls', explanation, remediation, evidence });

/** Validate an HLS master playlist. */
export function validateMaster(m: HlsMaster): SpecFinding[] {
  const out: SpecFinding[] = [];
  if (m.warnings.some((w) => /EXTM3U/.test(w))) out.push(finding('SA-HLS-002', 'error', 'The master playlist does not start with #EXTM3U.', 'Ensure the first line is #EXTM3U.', {}));

  for (const v of m.variants) {
    if (v.bandwidth == null) out.push(finding('SA-HLS-002', 'error', `A variant (${v.uri || 'no URI'}) is missing BANDWIDTH.`, 'Add BANDWIDTH to every EXT-X-STREAM-INF.', { uri: v.uri }));
    if (v.codecs.length === 0) out.push(finding('SA-HLS-002', 'warning', `Variant ${v.uri || '(no URI)'} declares no CODECS.`, 'Declare CODECS on every variant so players can select without downloading.', { uri: v.uri }));
    if (!v.uri) out.push(finding('SA-HLS-002', 'error', 'An EXT-X-STREAM-INF has no URI on the following line.', 'Each variant must be followed by its playlist URI.', {}));
  }

  // Duplicate variants (same bandwidth + resolution + codecs).
  const seen = new Set<string>();
  for (const v of m.variants) {
    const key = `${v.bandwidth}|${v.resolution ? `${v.resolution.width}x${v.resolution.height}` : ''}|${[...v.codecs].sort().join(',')}`;
    if (seen.has(key)) out.push(finding('SA-HLS-002', 'warning', `Duplicate variant (${key}).`, 'Remove duplicate EXT-X-STREAM-INF entries.', { key }));
    seen.add(key);
  }

  // Referenced rendition groups must exist.
  const groups = new Set(m.renditions.map((r) => r.groupId).filter(Boolean) as string[]);
  for (const v of m.variants) {
    for (const [attr, g] of [['AUDIO', v.audioGroup], ['SUBTITLES', v.subtitlesGroup]] as const) {
      if (g && !groups.has(g)) out.push(finding('SA-HLS-002', 'error', `Variant references ${attr} group "${g}" which is not defined by any EXT-X-MEDIA.`, `Define an EXT-X-MEDIA rendition for group ${g}, or remove the reference.`, { group: g }));
    }
  }
  return out;
}

/** Validate an HLS media playlist. `live` overrides the VOD/live decision when known. */
export function validateMedia(m: HlsMedia, opts: { live?: boolean } = {}): SpecFinding[] {
  const out: SpecFinding[] = [];
  const isLive = opts.live ?? (m.playlistType === 'VOD' ? false : !m.endList);

  if (m.warnings.some((w) => /EXTM3U/.test(w))) out.push(finding('SA-HLS-003', 'error', 'The media playlist does not start with #EXTM3U.', 'Ensure the first line is #EXTM3U.', {}));
  if (m.targetDuration == null) out.push(finding('SA-HLS-003', 'error', 'EXT-X-TARGETDURATION is missing.', 'Declare EXT-X-TARGETDURATION.', {}));

  // Segment durations must round within TARGETDURATION.
  if (m.targetDuration != null) {
    for (const s of m.segments) {
      if (Math.round(s.duration) > m.targetDuration) out.push(finding('SA-HLS-003', 'warning', `Segment ${s.uri} duration ${s.duration}s exceeds TARGETDURATION ${m.targetDuration}s.`, 'Keep EXTINF durations within EXT-X-TARGETDURATION.', { uri: s.uri, duration: s.duration, targetDuration: m.targetDuration }));
    }
  }

  // PROGRAM-DATE-TIME must be monotonically increasing where present.
  let prevPdt: number | null = null;
  for (const s of m.segments) {
    if (!s.programDateTime) continue;
    const t = Date.parse(s.programDateTime);
    if (Number.isFinite(t)) {
      if (prevPdt != null && t < prevPdt) out.push(finding('SA-HLS-003', 'error', `PROGRAM-DATE-TIME regresses at ${s.uri}.`, 'PROGRAM-DATE-TIME must increase monotonically.', { uri: s.uri, programDateTime: s.programDateTime }));
      prevPdt = t;
    }
  }

  // VOD playlists must end with EXT-X-ENDLIST; live playlists must not.
  if (!isLive && !m.endList) out.push(finding('SA-HLS-003', 'error', 'A VOD/finished media playlist is missing EXT-X-ENDLIST.', 'Terminate VOD playlists with EXT-X-ENDLIST.', {}));

  // Encryption signalling (no key retrieval).
  for (const k of m.keys) {
    if (k.method === 'NONE') continue;
    if (!k.uri) out.push(finding('SA-HLS-004', 'error', `EXT-X-KEY METHOD=${k.method} has no URI.`, 'Add the key URI (RADAR never fetches it).', { method: k.method }));
    if ((k.method === 'SAMPLE-AES' || k.method === 'SAMPLE-AES-CTR') && !k.keyFormat) out.push(finding('SA-HLS-004', 'warning', `EXT-X-KEY METHOD=${k.method} is missing KEYFORMAT.`, 'Declare KEYFORMAT so the DRM system is identifiable.', { method: k.method }));
  }

  // CMAF media playlists need EXT-X-MAP for the initialisation segment.
  if (m.segments.length > 0 && !m.map && m.version != null && m.version >= 6) {
    out.push(finding('SA-HLS-003', 'warning', 'A CMAF media playlist has no EXT-X-MAP initialisation segment.', 'Reference the CMAF init segment with EXT-X-MAP.', {}));
  }
  return out;
}

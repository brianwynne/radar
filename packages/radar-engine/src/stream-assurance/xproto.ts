// Cross-protocol comparison: a DASH presentation and an HLS presentation of the SAME service must
// agree on encryption identity (KID / DRM systems), codecs and live/VOD mode. Manifest-level; the
// per-object KID comparison across protocols uses the init segments (see classify.classifyDrmSignalling).
import type { SpecFinding } from './rules.js';

// HLS EXT-X-KEY KEYFORMAT → canonical DRM system UUID (lowercase), for cross-protocol comparison.
const KEYFORMAT_TO_SYSTEM: Record<string, string> = {
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
  'com.widevine.alpha': 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
  'com.microsoft.playready': '9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': '9a04f079-9840-4286-ab92-e65be0885f95',
  'com.apple.streamingkeydelivery': '94ce86fb-07ff-4f43-adb8-93d2fa968ca2', // FairPlay
};

export interface CrossProtocolInput {
  dashDefaultKid?: string | null;
  hlsInitKid?: string | null; // KID from the HLS init segment (EXT-X-MAP), when parsed
  dashSystems?: string[]; // DASH ContentProtection DRM system UUIDs
  hlsKeyFormats?: string[]; // HLS EXT-X-KEY KEYFORMAT values
  dashCodecs?: string[];
  hlsCodecs?: string[];
  dashLive?: boolean | null;
  hlsLive?: boolean | null;
}

const norm = (s: string | null | undefined): string | null => (s ? s.toLowerCase() : null);
const codecFamilies = (cs?: string[]): Set<string> => new Set((cs ?? []).map((c) => c.split('.')[0].toLowerCase()).filter(Boolean));
const setsEqual = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

const finding = (ruleId: string, severity: SpecFinding['severity'], explanation: string, remediation: string, evidence: Record<string, unknown>): SpecFinding =>
  ({ ruleId, classification: ruleId.startsWith('SA-XDRM-001') ? 'DASH_HLS_MISMATCH' : ruleId === 'SA-XDRM-002' ? 'DASH_HLS_MISMATCH' : 'SPEC_CONFORMANCE_ERROR', severity, protocol: 'crossproto', explanation, remediation, evidence });

/** Compare a DASH and an HLS presentation of the same service. */
export function compareDashHls(input: CrossProtocolInput): SpecFinding[] {
  const out: SpecFinding[] = [];

  // Encryption identity: KID (via init segments) must match.
  const dk = norm(input.dashDefaultKid), hk = norm(input.hlsInitKid);
  if (dk && hk && dk !== hk) {
    out.push(finding('SA-XDRM-001', 'critical', `DASH default_KID ${dk} does not match the HLS init-segment KID ${hk}.`, 'Re-package so both protocols reference the same key identity, from the same origin object set.', { dashDefaultKid: dk, hlsInitKid: hk }));
  }

  // DRM systems: DASH ContentProtection vs HLS KEYFORMAT-derived systems.
  if (input.dashSystems && input.hlsKeyFormats) {
    const dashSys = new Set(input.dashSystems.map((s) => s.toLowerCase()));
    const hlsSys = new Set(input.hlsKeyFormats.map((f) => KEYFORMAT_TO_SYSTEM[f.toLowerCase()]).filter(Boolean));
    if (hlsSys.size > 0 && dashSys.size > 0 && !setsEqual(dashSys, hlsSys)) {
      out.push(finding('SA-XDRM-001', 'critical', `DASH advertises DRM systems {${[...dashSys].join(', ')}} while HLS advertises {${[...hlsSys].join(', ')}}.`, 'Package the same DRM systems in both protocols.', { dashSystems: [...dashSys], hlsSystems: [...hlsSys] }));
    }
  }

  // Codec families.
  const dashCodecs = codecFamilies(input.dashCodecs), hlsCodecs = codecFamilies(input.hlsCodecs);
  if (dashCodecs.size > 0 && hlsCodecs.size > 0 && !setsEqual(dashCodecs, hlsCodecs)) {
    out.push(finding('SA-XDRM-002', 'error', `DASH codecs {${[...dashCodecs].join(', ')}} differ from HLS codecs {${[...hlsCodecs].join(', ')}}.`, 'Align the packaged codec set across DASH and HLS.', { dashCodecs: [...dashCodecs], hlsCodecs: [...hlsCodecs] }));
  }

  // Presentation mode.
  if (input.dashLive != null && input.hlsLive != null && input.dashLive !== input.hlsLive) {
    out.push(finding('SA-XDRM-002', 'error', `DASH is ${input.dashLive ? 'live' : 'static'} while HLS is ${input.hlsLive ? 'live' : 'VOD'}.`, 'Package the same live/VOD mode in both protocols.', { dashLive: input.dashLive, hlsLive: input.hlsLive }));
  }
  return out;
}

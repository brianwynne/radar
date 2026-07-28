// Cross-CDN media-fragment timeline consistency. The same fragment URL fetched through several CDNs
// must resolve to the same fragment generation — same decode time (tfdt) and sequence number. When a
// CDN returns a different decode time for a given URL, it has cached a stale/wrong fragment below the
// manifest (a cache-key or origin-variant problem at the segment level). Pure, no I/O.
import type { CdnKind } from './cdn-headers.js';
import type { Finding } from './classify.js';
import type { FragmentInfo } from './fragment.js';
import { rule } from './rules.js';

export interface EndpointFragment {
  endpointId: string;
  provider: CdnKind;
  role: 'reference' | 'candidate';
  fragment: FragmentInfo | null;
}

/** Compare the same media fragment served through multiple CDNs; flag decode-time / sequence drift. */
export function compareFragmentTimelines(fragments: EndpointFragment[]): Finding[] {
  const withFrag = fragments.filter((f) => f.fragment && f.fragment.baseMediaDecodeTime != null);
  const ref = withFrag.find((f) => f.role === 'reference') ?? withFrag[0];
  if (!ref?.fragment) return [];
  const refDts = ref.fragment.baseMediaDecodeTime;
  const refSeq = ref.fragment.sequenceNumber;
  const findings: Finding[] = [];

  for (const f of withFrag) {
    if (f.endpointId === ref.endpointId || !f.fragment) continue;
    const dts = f.fragment.baseMediaDecodeTime;
    const seq = f.fragment.sequenceNumber;
    const dtsDiffers = refDts != null && dts != null && dts !== refDts;
    const seqDiffers = refSeq != null && seq != null && seq !== refSeq;
    if (!dtsDiffers && !seqDiffers) continue;
    const r = rule('SA-FRAG-001');
    findings.push({
      ruleId: r.id, classification: 'FRAGMENT_TIMELINE_DRIFT', severity: r.severity, endpointId: f.endpointId,
      provider: f.provider, protocol: 'cmaf', likelyLayer: 'edge',
      explanation:
        `${f.provider} returned a different fragment for the same URL than ${ref.provider} (reference)` +
        (dtsDiffers ? ` — decode time ${dts} vs ${refDts}` : '') +
        (seqDiffers ? ` — sequence ${seq} vs ${refSeq}` : '') +
        '. This CDN has cached a stale or wrong fragment beneath the manifest.',
      remediation: r.remediation,
      evidence: { baseMediaDecodeTime: dts, referenceBaseMediaDecodeTime: refDts, sequenceNumber: seq, referenceSequenceNumber: refSeq, referenceEndpoint: ref.endpointId },
    });
  }
  return findings;
}

// Synthetic bgp.tools fixtures for local development, tests and the (dev-only) demo toggle. All
// data is CLEARLY synthetic: documentation prefixes (RFC 5737 / RFC 3849) and a private-use
// hijacker ASN, so it can never be mistaken for live routing. The expected origin AS2110 is RTÉ's
// public ASN; the scenarios exercise the documented-core signals end to end.
import type { MonitoredPrefix, RawRoutingObservation } from './types.js';

/** The visibility-hit count that represents full/global visibility in these fixtures. */
export const MOCK_FULL_VISIBILITY_HITS = 100;

export const RTE_ORIGIN_ASN = 2110; // RTÉ — public origin ASN
const HIJACKER_ASN = 64500; // RFC 5398 private-use range — unmistakably synthetic

export const MOCK_MONITORED_PREFIXES: MonitoredPrefix[] = [
  { prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: RTE_ORIGIN_ASN, description: 'Donnybrook delivery /24' },
  { prefix: '2001:db8::/32', addressFamily: 'ipv6', expectedOriginAsn: RTE_ORIGIN_ASN, description: 'Donnybrook delivery v6' },
];

export type MockScenario =
  | 'healthy'
  | 'partial_visibility_loss'
  | 'full_withdrawal'
  | 'unexpected_origin'
  | 'moas_partial_hijack'
  | 'recovery';

export const MOCK_SCENARIOS: MockScenario[] = [
  'healthy', 'partial_visibility_loss', 'full_withdrawal', 'unexpected_origin', 'moas_partial_hijack', 'recovery',
];

/** Build the raw observations a scenario reports for the monitored prefixes at `observedAt`. */
export function scenarioObservations(scenario: MockScenario, observedAt: Date): RawRoutingObservation[] {
  const [v4, v6] = MOCK_MONITORED_PREFIXES;
  const obs = (p: MonitoredPrefix, origins: { asn: number; hits: number }[]): RawRoutingObservation => ({
    prefix: p.prefix, addressFamily: p.addressFamily, origins, observedAt,
  });
  switch (scenario) {
    case 'healthy':
    case 'recovery':
      return [obs(v4, [{ asn: RTE_ORIGIN_ASN, hits: 98 }]), obs(v6, [{ asn: RTE_ORIGIN_ASN, hits: 95 }])];
    case 'partial_visibility_loss':
      // Expected origin still sole, but seen by fewer collectors → degraded by visibility ratio
      // (70%/78% sit between the critical 50% and warning 85% thresholds).
      return [obs(v4, [{ asn: RTE_ORIGIN_ASN, hits: 70 }]), obs(v6, [{ asn: RTE_ORIGIN_ASN, hits: 78 }])];
    case 'full_withdrawal':
      // v4 gone entirely (no origins); v6 still healthy.
      return [obs(v4, []), obs(v6, [{ asn: RTE_ORIGIN_ASN, hits: 96 }])];
    case 'unexpected_origin':
      // v4 originated ONLY by a foreign ASN (expected absent) → hijack/takeover; v6 healthy.
      return [obs(v4, [{ asn: HIJACKER_ASN, hits: 61 }]), obs(v6, [{ asn: RTE_ORIGIN_ASN, hits: 94 }])];
    case 'moas_partial_hijack':
      // Expected origin present AND a foreign origin announcing the same prefix (MOAS) → degraded.
      return [obs(v4, [{ asn: RTE_ORIGIN_ASN, hits: 88 }, { asn: HIJACKER_ASN, hits: 24 }]), obs(v6, [{ asn: RTE_ORIGIN_ASN, hits: 93 }])];
  }
}

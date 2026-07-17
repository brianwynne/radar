// Major Irish consumer ISPs, as request-identity presets for the Explain workflow. Picking a
// subscriber ISP fills the Explain scenario with that network's identity (country + origin ASN +
// a representative client subnet) so the operator can see how the LIVE NS1 filter chain steers a
// real user on that ISP — which delivery platform they get, and why.
//
// The ASNs are validated against live resolutions of live.nsone.rte.ie (the origin ASNs NS1's
// config actually keys on). RADAR does NOT hardcode the outcome: the served platform comes from
// evaluating whatever config is currently loaded, so this stays correct as the config changes.
// Subnets are representative /24s within each operator's Irish allocation (illustrative; used only
// for the prefix fence and display — the ASN drives identity).
import type { ExplainScenario } from '../features/ExplainPanel';

export interface Isp {
  id: string;
  name: string;
  asn: string;
  country: string;
  ecsPrefix: string;
  resolverIp: string;
}

export const ISPS: Isp[] = [
  { id: 'eir', name: 'Eir', asn: '5466', country: 'IE', ecsPrefix: '86.40.0.0/24', resolverIp: '86.40.0.1' },
  { id: 'vodafone', name: 'Vodafone Ireland', asn: '15502', country: 'IE', ecsPrefix: '109.76.0.0/24', resolverIp: '109.76.0.1' },
  { id: 'three', name: 'Three Ireland', asn: '13280', country: 'IE', ecsPrefix: '37.228.192.0/24', resolverIp: '37.228.192.1' },
  { id: 'virginmedia', name: 'Virgin Media (Liberty Global)', asn: '6830', country: 'IE', ecsPrefix: '89.100.0.0/24', resolverIp: '89.100.0.1' },
  { id: 'sky', name: 'Sky Ireland', asn: '5607', country: 'IE', ecsPrefix: '176.61.0.0/24', resolverIp: '176.61.0.1' },
  { id: 'offisland', name: 'Off-island (e.g. Germany)', asn: '3320', country: 'DE', ecsPrefix: '84.128.0.0/24', resolverIp: '84.128.0.1' },
];

/** The scenario fields an ISP preset sets (identity only; health toggles are left alone). */
export function ispToScenario(isp: Isp): Pick<ExplainScenario, 'resolverIp' | 'ecsPresent' | 'ecsPrefix' | 'country' | 'asn'> {
  return { resolverIp: isp.resolverIp, ecsPresent: true, ecsPrefix: isp.ecsPrefix, country: isp.country, asn: isp.asn };
}

/** Identify which ISP a scenario currently represents (by origin ASN + country), else undefined. */
export function matchIsp(s: Pick<ExplainScenario, 'asn' | 'country'>): Isp | undefined {
  return ISPS.find((i) => i.asn === s.asn.trim() && i.country.toUpperCase() === s.country.trim().toUpperCase());
}

// Configured Live Steering ISP scenarios, re-evaluated when a watched record changes.
// Synthetic ASNs/prefixes for the mock — illustrative, not authoritative routing data.
// (Kept in step with apps/web/src/pages/LiveSteering.tsx.)
import type { IspScenario, WatchedRecord } from './types.js';

export const ISP_SCENARIOS: IspScenario[] = [
  { id: 'eir', name: 'Eir', asn: 5466, ecsPrefix: '185.2.100.0/24' },
  { id: 'virgin', name: 'Virgin Media', asn: 6830, ecsPrefix: '80.233.0.0/24' },
  { id: 'vodafone', name: 'Vodafone', asn: 15502, ecsPrefix: '109.76.0.0/24' },
  { id: 'three', name: 'Three', asn: 34218, ecsPrefix: '37.228.0.0/24' },
  { id: 'sky', name: 'Sky', asn: 5607, ecsPrefix: '2.216.0.0/24' },
  { id: 'digiweb', name: 'Digiweb', asn: 15919, ecsPrefix: '89.19.0.0/24' },
];

/** Records RADAR watches for change (the Live Steering evaluation target). */
// live.rte.ie is a CNAME pointing at the currently-active nsone steering record; watching it means
// change-detection fires when RTÉ re-points it (i.e. the active record switches).
export const DEFAULT_WATCHED_RECORDS: WatchedRecord[] = [{ zone: 'rte.ie', domain: 'live.rte.ie', type: 'CNAME' }];

/** CONFIGURED mapping of requester ASN → preferred RTÉ network path (manually maintained;
 *  kept in step with apps/web/src/topology/model.ts). */
export function preferredPathForAsn(asn?: number): string {
  if (asn === undefined) return 'Unknown (no ASN)';
  if ([5466, 15502, 25441].includes(asn)) return 'Eir PNI';
  if (asn === 6830) return 'Virgin / Liberty PNI';
  if ([1213, 2128, 43760].includes(asn)) return 'INEX';
  return 'Transit';
}

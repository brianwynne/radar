// Steering-matrix scenarios. Each row's OUTCOME is produced by calling /api/v1/dns/explain
// (never hard-coded). These entries only describe the request inputs and the configured
// context (country/ASN/network) for the labelled scenario.
import type { ExplainRequest } from '../api/types';

export interface SteeringScenario {
  id: string;
  label: string;
  country: string;
  asn: string;
  network: string;
  prefixCondition: string;
  request: ExplainRequest;
}

export const SCENARIOS: SteeringScenario[] = [
  {
    id: 'ie-eir-ecs',
    label: 'Ireland / Eir / ECS present',
    country: 'IE',
    asn: '5466',
    network: 'Eir',
    prefixCondition: '—',
    request: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: 5466 } },
  },
  {
    id: 'ie-resolver',
    label: 'Ireland / resolver-only',
    country: 'IE',
    asn: '5466',
    network: 'Eir',
    prefixCondition: '—',
    request: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', scenario: { resolverIp: '9.9.9.9', ecsPresent: false, country: 'IE', asn: 5466 } },
  },
  {
    id: 'prefix-override',
    label: 'Matching prefix override',
    country: 'IE',
    asn: '5466',
    network: 'Eir',
    prefixCondition: '192.0.2.0/24',
    request: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '192.0.2.5/32', country: 'IE', asn: 5466 } },
  },
  {
    id: 'realta-down',
    label: 'Réalta unavailable',
    country: 'IE',
    asn: '5466',
    network: 'Eir',
    prefixCondition: '—',
    request: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: 5466, healthOverrides: { 'ans-realta': false } } },
  },
  {
    id: 'unsupported',
    label: 'Unsupported filter (shed_load)',
    country: 'IE',
    asn: '5466',
    network: 'Eir',
    prefixCondition: '—',
    request: { zone: 'rte.ie', domain: 'vod.rte.ie', type: 'A', scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: 5466 } },
  },
  {
    id: 'untagged-fallback',
    label: 'Untagged fallback (off-net)',
    country: 'DE',
    asn: '3320',
    network: 'Transit',
    prefixCondition: '—',
    request: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '91.0.0.0/24', country: 'DE', asn: 3320 } },
  },
];

/** Convert a scenario into the Explain page's pre-fill form shape. */
export function scenarioToPrefill(s: SteeringScenario) {
  return {
    zone: s.request.zone,
    domain: s.request.domain,
    type: s.request.type,
    resolverIp: s.request.scenario.resolverIp,
    ecsPresent: s.request.scenario.ecsPresent,
    ecsPrefix: s.request.scenario.ecsPrefix ?? '',
    country: s.request.scenario.country ?? '',
    asn: s.request.scenario.asn !== undefined ? String(s.request.scenario.asn) : '',
    realtaDown: Boolean(s.request.scenario.healthOverrides?.['ans-realta'] === false),
  };
}

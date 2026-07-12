// Central RADAR-owned ISP DNS-observation scenarios. Resolver addresses and ECS subnets are
// PLACEHOLDERS (RFC 5737 / RFC 3849 documentation ranges) until RTÉ supplies confirmed
// resolver endpoints — they are deliberately NOT real ISP resolver IPs. Never invent real
// resolver addresses here. Kept in step with apps/api/src/change-detection/isps.ts.
import type { DnsObservationScenario } from './types.js';

/** Watched record (matches the Live Steering evaluation target). */
const ZONE = 'rte.ie';
const DOMAIN = 'live.rte.ie';

export const DNS_OBSERVATION_SCENARIOS: DnsObservationScenario[] = [
  {
    ispId: 'eir', ispName: 'Eir', asn: 5466, country: 'IE',
    resolvers: ['192.0.2.11'], ecsSubnet: '203.0.113.0/24',
    zone: ZONE, domain: DOMAIN, recordType: 'A', expectedRepresentativeness: 'medium',
    provenance: 'MOCK resolver/ECS (RFC 5737) — replace with RTÉ-confirmed Eir resolver.',
    notes: 'Placeholder endpoints; a direct-resolver result is not proof for all Eir subscribers.',
  },
  {
    ispId: 'virgin', ispName: 'Virgin Media / Liberty Global', asn: 6830, country: 'IE',
    resolvers: ['192.0.2.12'], ecsSubnet: '203.0.113.32/29',
    zone: ZONE, domain: DOMAIN, recordType: 'A', expectedRepresentativeness: 'medium',
    provenance: 'MOCK resolver/ECS (RFC 5737) — replace with RTÉ-confirmed Virgin/Liberty resolver.',
    notes: 'Placeholder endpoints; Liberty Global resolvers may be shared across markets.',
  },
  {
    ispId: 'vodafone', ispName: 'Vodafone', asn: 15502, country: 'IE',
    resolvers: ['192.0.2.13'], ecsSubnet: '203.0.113.64/26',
    zone: ZONE, domain: DOMAIN, recordType: 'A', expectedRepresentativeness: 'medium',
    provenance: 'MOCK resolver/ECS (RFC 5737) — replace with RTÉ-confirmed Vodafone resolver.',
    notes: 'Placeholder endpoints; querying a resolver is not the same as being on-net.',
  },
  {
    ispId: 'three', ispName: 'Three', asn: 34218, country: 'IE',
    resolvers: ['192.0.2.14'],
    zone: ZONE, domain: DOMAIN, recordType: 'A', expectedRepresentativeness: 'low',
    provenance: 'MOCK resolver (RFC 5737) — no approved ECS subnet; replace with RTÉ-confirmed Three resolver.',
    notes: 'Mobile ASN; resolver location and ECS support uncertain → low representativeness.',
  },
  {
    ispId: 'sky', ispName: 'Sky', asn: 5607, country: 'IE',
    resolvers: ['192.0.2.15'], ecsSubnet: '203.0.113.128/25',
    zone: ZONE, domain: DOMAIN, recordType: 'A', expectedRepresentativeness: 'medium',
    provenance: 'MOCK resolver/ECS (RFC 5737) — replace with RTÉ-confirmed Sky resolver.',
    notes: 'Placeholder endpoints; Sky IE may share infrastructure with Sky UK.',
  },
];

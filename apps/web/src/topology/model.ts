// RADAR-CONFIGURED delivery-topology model. These are MANUALLY MAINTAINED architecture
// values and relationships — NOT live measurements and NOT fetched from NS1. Every value
// is labelled so the UI can never present it as observed telemetry.
//
// Responsibility boundary (docs/frontend/architecture.md):
//   NS1 selects the delivery PLATFORM (Réalta / Fastly / Akamai / CloudFront).
//   Cloudflare then selects the Réalta ORIGIN POOL. NS1 never selects a cache/pool.

export type ConfigLabel = 'CONFIGURED' | 'MANUALLY MAINTAINED';

/** Platforms NS1 can steer to (the NS1 answer set). */
export const PLATFORMS = ['Réalta', 'Fastly', 'Akamai', 'CloudFront'] as const;

/** The Réalta origin-selection chain, downstream of NS1 and owned by Cloudflare. */
export const REALTA_CHAIN = [
  'Réalta',
  'Cloudflare Load Balancer',
  'Donnybrook Pool 1',
  'Donnybrook Pool 2',
  'External Pool 1',
  'External Pool 2',
  'Origin',
] as const;

export interface NetworkPath {
  id: string;
  label: string;
  note: string;
  target?: string;
  provenance: ConfigLabel;
  telemetryFutureSource: string;
}

export const NETWORK_PATHS: NetworkPath[] = [
  { id: 'eir', label: 'Eir PNI', note: 'Private network interconnect', target: '70% utilisation (preferred)', provenance: 'CONFIGURED', telemetryFutureSource: 'router/interface telemetry' },
  { id: 'virgin', label: 'Virgin / Liberty PNI', note: 'Private network interconnect', target: '70% utilisation (preferred)', provenance: 'CONFIGURED', telemetryFutureSource: 'router/interface telemetry' },
  { id: 'inex', label: 'INEX', note: 'Internet Neutral Exchange (peering)', provenance: 'CONFIGURED', telemetryFutureSource: 'network telemetry adapter' },
  { id: 'transit', label: 'Transit', note: 'IP transit (fallback)', provenance: 'CONFIGURED', telemetryFutureSource: 'network telemetry adapter' },
];

export interface CapacityItem {
  label: string;
  configuredCapacity?: string;
  configuredTarget?: string;
  provenance: ConfigLabel;
  telemetryFutureSource: string;
}

export const CAPACITY: CapacityItem[] = [
  { label: 'Donnybrook — per cache', configuredCapacity: '~80 Gb/s (practical, CPU-bound)', provenance: 'MANUALLY MAINTAINED', telemetryFutureSource: 'Varnish telemetry' },
  { label: 'Donnybrook — 4 caches, aggregate', configuredCapacity: '~320 Gb/s', provenance: 'MANUALLY MAINTAINED', telemetryFutureSource: 'Varnish telemetry' },
  { label: 'External Pool 1 — 4 caches', configuredCapacity: '~700 Gb/s outbound', provenance: 'MANUALLY MAINTAINED', telemetryFutureSource: 'Cloudflare API' },
  { label: 'External Pool 2 — 4 caches', configuredCapacity: '~700 Gb/s outbound', provenance: 'MANUALLY MAINTAINED', telemetryFutureSource: 'Cloudflare API' },
  { label: 'Preferred PNI utilisation target', configuredTarget: '70%', provenance: 'CONFIGURED', telemetryFutureSource: 'router/interface telemetry' },
];

/** CONFIGURED mapping of requester ASN → preferred RTÉ network path. Manually maintained;
 *  a routing/telemetry adapter replaces this later. */
export function networkPathForAsn(asn?: number): { label: string; provenance: ConfigLabel } {
  if (asn === undefined) return { label: 'Unknown (no ASN)', provenance: 'CONFIGURED' };
  if ([5466, 15502, 25441].includes(asn)) return { label: 'Eir PNI', provenance: 'CONFIGURED' };
  if (asn === 6830) return { label: 'Virgin / Liberty PNI', provenance: 'CONFIGURED' };
  if ([1213, 2128, 43760].includes(asn)) return { label: 'INEX', provenance: 'CONFIGURED' };
  return { label: 'Transit', provenance: 'CONFIGURED' };
}

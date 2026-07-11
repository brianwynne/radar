// SYNTHETIC NS1 fixtures for the mock adapter and contract tests (docs/ns1/developer-
// guide.md §28). These are NOT production payloads and NOT captured from a real NS1
// account (IBM's API Hub is inaccessible to the build agent). They follow the NS1 Connect
// object shape grounded in the NS1 Go SDK (guide §4, §7) so the mock behaves like the
// live client. Values are illustrative; do not treat them as RTÉ configuration.
//
// Embedded as TypeScript (not *.json) so they compile into dist with no file-copy step.

const SYNTHETIC =
  'SYNTHETIC / MOCK — not real RTÉ or NS1 data. Shape follows the NS1 Connect API (github.com/ns1/ns1-go).';

/** GET /v1/zones */
export const ZONES_LIST: unknown = [
  { _radar_note: SYNTHETIC, zone: 'rte.ie', network_pools: [], records: 1 },
];

/** GET /v1/zones/rte.ie */
export const ZONE_RTE_IE: unknown = {
  _radar_note: SYNTHETIC,
  zone: 'rte.ie',
  ttl: 3600,
  records: [{ domain: 'live.rte.ie', type: 'A', ttl: 30, short_answers: ['192.0.2.10'] }],
};

/** GET /v1/zones/rte.ie/live.rte.ie/A — the first-vertical-slice record (guide §28):
 *  Réalta / Fastly / Akamai / CloudFront with up, asn, ip_prefixes, weight metadata, a
 *  feed-controlled value, ECS enabled, and an ordered Filter Chain. */
export const RECORD_LIVE_RTE_IE_A: unknown = {
  _radar_note: SYNTHETIC,
  id: 'demo-live-rte-ie-a',
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  type: 'A',
  ttl: 30,
  use_client_subnet: true, // ECS honoured for this record (guide §9)
  answers: [
    {
      id: 'ans-realta',
      answer: ['192.0.2.10'],
      meta: {
        up: true,
        note: 'Réalta',
        weight: 70,
        country: ['IE'],
        asn: [5466, 15502, 25441],
        ip_prefixes: ['192.0.2.0/24', '2001:db8::/32'],
      },
    },
    {
      id: 'ans-fastly',
      answer: ['192.0.2.20'],
      // Feed-controlled up value (guide §18) — must never be shown as static.
      meta: { up: { feed: 'feed-fastly-health' }, note: 'Fastly', weight: 20 },
    },
    { id: 'ans-akamai', answer: ['192.0.2.30'], meta: { up: true, note: 'Akamai', weight: 10 } },
    { id: 'ans-cloudfront', answer: ['192.0.2.40'], meta: { up: true, note: 'CloudFront standby', weight: 0 } },
  ],
  // Ordered Filter Chain (order is significant and must be preserved — guide §2.7).
  filters: [
    { filter: 'up' },
    { filter: 'geotarget_country' },
    { filter: 'netfence_asn', config: { remove_no_asn: false } },
    { filter: 'netfence_prefix', config: { remove_no_ip_prefixes: false } },
    { filter: 'weighted_shuffle' },
    { filter: 'select_first_n', config: { N: 1 } },
  ],
  regions: {},
};

/** GET /v1/account/activity */
export const ACTIVITY: unknown = [
  { _radar_note: SYNTHETIC, id: 'act-1', action: 'update', resource_type: 'record', resource_id: 'live.rte.ie/A' },
  { _radar_note: SYNTHETIC, id: 'act-2', action: 'update', resource_type: 'zone', resource_id: 'rte.ie' },
];

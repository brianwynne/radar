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
  records: [
    { domain: 'live.rte.ie', type: 'A', ttl: 30, short_answers: ['192.0.2.10'] },
    { domain: 'vod.rte.ie', type: 'A', ttl: 30, short_answers: ['192.0.2.10'] },
  ],
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

/** GET /v1/zones/rte.ie/live.rte.ie/CNAME — the live steering record as it really is: a
 *  CNAME whose answers are delivery-platform hostnames (Réalta/Fastly/Akamai/CloudFront),
 *  steered by the fence-based Filter Chain. Synthetic values; platform is derived from the
 *  answer RDATA, not the note. Mirrors the CNAME default watched record. */
export const RECORD_LIVE_RTE_IE_CNAME: unknown = {
  _radar_note: SYNTHETIC,
  id: 'demo-live-rte-ie-cname',
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  type: 'CNAME',
  ttl: 180,
  use_client_subnet: true, // ECS honoured for this record (guide §9)
  answers: [
    {
      id: 'ans-realta',
      answer: ['liveedge.rte.ie'], // Réalta (RTÉ CDN)
      meta: { up: true, note: 'Réalta', weight: 70, country: ['IE'], asn: [5466, 15502, 25441] },
    },
    { id: 'ans-fastly', answer: ['t.sni.global.fastly.net'], meta: { up: { feed: 'feed-fastly-health' }, note: 'Fastly', weight: 15 } },
    { id: 'ans-akamai', answer: ['live.rte.ie.akamaized.net'], meta: { up: true, note: 'Akamai', weight: 15 } },
    { id: 'ans-cloudfront', answer: ['d3k5dscs9b55g6.cloudfront.net'], meta: { up: true, note: 'CloudFront standby', weight: 0 } },
  ],
  // Ordered Filter Chain (order is significant and must be preserved — guide §2.7).
  filters: [
    { filter: 'geofence_country', config: { remove_no_location: '1' } },
    { filter: 'netfence_asn', config: { remove_no_asn: '1' } },
    { filter: 'netfence_prefix', config: { remove_no_ip_prefixes: '1' } },
    { filter: 'weighted_shuffle' },
    { filter: 'select_first_n', config: { N: 1 } },
  ],
  regions: {},
};

/** GET /v1/zones/rte.ie/vod.rte.ie/A — a second synthetic record whose Filter Chain
 *  contains an UNSUPPORTED filter (sticky_shuffle), so RADAR reports a PARTIAL evaluation
 *  rather than inventing behaviour (guide §17). Used by the Steering Matrix. */
export const RECORD_VOD_RTE_IE_A: unknown = {
  _radar_note: SYNTHETIC,
  id: 'demo-vod-rte-ie-a',
  zone: 'rte.ie',
  domain: 'vod.rte.ie',
  type: 'A',
  ttl: 30,
  use_client_subnet: true,
  answers: [
    { id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: true, note: 'Réalta', weight: 70, country: ['IE'], asn: [5466] } },
    { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, note: 'Fastly', weight: 30 } },
  ],
  filters: [
    { filter: 'up' },
    // Not in the RADAR engine registry → unsupported → partial evaluation.
    { filter: 'sticky_shuffle', config: {} },
    { filter: 'weighted_shuffle' },
    { filter: 'select_first_n', config: { N: 1 } },
  ],
  regions: {},
};

/** GET /v1/account/activity — synthetic entries. Exact NS1 wire fields are FIXTURE-
 *  PENDING; these use plausible names so the normaliser has something to map. */
export const ACTIVITY: unknown = [
  { _radar_note: SYNTHETIC, id: 'act-1', timestamp: '2026-07-01T09:15:00Z', user: 'brian@rte.ie', action: 'update', resource_type: 'record', resource_id: 'live.rte.ie/A', status: 'success', note: 'weight adjusted' },
  { _radar_note: SYNTHETIC, id: 'act-2', timestamp: '2026-07-01T08:40:00Z', api_key_name: 'radar-read-only', action: 'view', resource_type: 'zone', resource_id: 'rte.ie', status: 'success' },
  { _radar_note: SYNTHETIC, id: 'act-3', timestamp: '2026-06-30T22:05:00Z', user: 'ops@rte.ie', action: 'update', resource_type: 'record', resource_id: 'vod.rte.ie/A', status: 'success', note: 'filter chain edited' },
];

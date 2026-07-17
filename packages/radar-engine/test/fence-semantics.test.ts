// Fence-filter semantics: geofence_country / netfence_asn / netfence_prefix with the NS1
// "remove untagged on match" options (remove_no_location / remove_no_asn / remove_no_ip_prefixes,
// which arrive as the string "1"). These were confirmed against LIVE resolutions of
// live.nsone.rte.ie: off-island users get commercial-CDN only (Réalta dropped), on-net ISP users
// keep Réalta, and multiple ASN-tagged answers for one ASN all sum into the weighted shuffle.
//
// The record below is SYNTHETIC — it mirrors the real config's SHAPE (a main-CDN list, per-ISP
// answers, untagged "all other" fallbacks, a prefix answer, and an "all countries bar IE" geofence)
// without checking in RTÉ's production weights/ASNs.
import { describe, it, expect } from 'vitest';
import { evaluate, type NS1Record, type Scenario } from '../src/index.js';

const REALTA = ['liveedge.rte.ie'];
const AKAMAI = ['x.akamaized.net'];
const FASTLY = ['t.sni.global.fastly.net'];

const record: NS1Record = {
  zone: 'nsone.rte.ie',
  domain: 'live.nsone.rte.ie',
  type: 'CNAME',
  use_client_subnet: true,
  answers: [
    { id: 'main-realta', answer: REALTA, meta: { note: 'Main CDN', weight: 200, asn: [100, 200] } },
    { id: 'eir-realta', answer: REALTA, meta: { note: 'Réalta EIR', weight: 220, asn: [100] } },
    { id: 'eir-akamai', answer: AKAMAI, meta: { note: 'Akamai EIR', weight: 45, asn: [100] } },
    { id: 'eir-fastly', answer: FASTLY, meta: { note: 'Fastly EIR', weight: 45, asn: [100] } },
    { id: 'fastly-allother', answer: FASTLY, meta: { note: 'Fastly ALL OTHER', weight: 10 } },
    { id: 'akamai-allother', answer: AKAMAI, meta: { note: 'Akamai ALL OTHER', weight: 10 } },
    { id: 'prefix-realta', answer: REALTA, meta: { weight: 5, ip_prefixes: ['203.0.113.0/24'] } },
    { id: 'row-akamai', answer: AKAMAI, meta: { note: 'Bar IE', weight: 30, country: ['DE', 'FR'] } },
    { id: 'row-fastly', answer: FASTLY, meta: { note: 'Bar IE', weight: 30, country: ['DE', 'FR'] } },
  ],
  filters: [
    { filter: 'geofence_country', config: { remove_no_location: '1' } },
    { filter: 'netfence_asn', config: { remove_no_asn: '1' } },
    { filter: 'netfence_prefix', config: { remove_no_ip_prefixes: '1' } },
    { filter: 'weighted_shuffle', config: {} },
    { filter: 'select_first_n', config: { N: '1' } },
  ],
  regions: {},
};

const scen = (country: string, asn: number, ecsPrefix: string): Scenario => ({
  qname: 'live.nsone.rte.ie', qtype: 'CNAME', resolverIp: '0.0.0.0', ecsPresent: true, ecsPrefix, country, asn,
});
const share = (r: ReturnType<typeof evaluate>, platform: string) =>
  r.expectedDistribution?.shares.filter((s) => s.deliveryPlatform === platform).reduce((a, s) => a + s.share, 0) ?? 0;
const removedAt = (r: ReturnType<typeof evaluate>, type: string) => r.traces.find((t) => t.type === type)!.removedAnswerIds;

describe('platform mapping from RDATA (not just meta.note)', () => {
  it('derives Réalta/Akamai/Fastly from the answer target', () => {
    const r = evaluate(record, scen('IE', 100, '198.51.100.0/24'));
    const p = (id: string) => r.answers.find((a) => a.id === id)!.deliveryPlatform;
    expect(p('prefix-realta')).toBe('Réalta'); // no note — derived from liveedge.rte.ie
    expect(p('eir-akamai')).toBe('Akamai');
    expect(p('eir-fastly')).toBe('Fastly');
  });
});

describe('on-net IE ISP (AS100)', () => {
  const r = evaluate(record, scen('IE', 100, '198.51.100.0/24'));

  it('drops untagged "all other" answers because ASN-tagged answers matched', () => {
    expect(removedAt(r, 'netfence_asn')).toEqual(expect.arrayContaining(['fastly-allother', 'akamai-allother']));
  });

  it('sums both matching Réalta answers (main list + per-ISP) in the shuffle', () => {
    // Réalta 200 + 220 = 420, Akamai 45, Fastly 45 → 420/510 ≈ 0.824
    expect(share(r, 'Réalta')).toBeCloseTo(420 / 510, 5);
    expect(share(r, 'Akamai')).toBeCloseTo(45 / 510, 5);
    expect(r.selected && r.answers.find((a) => a.id === r.selected)!.deliveryPlatform).toBe('Réalta');
    expect(r.complete).toBe(true);
    expect(r.selectionDeterminism).toBe('probabilistic'); // weighted_shuffle over >1 answer
  });
});

describe('off-island user (DE) → commercial CDN only', () => {
  const r = evaluate(record, scen('DE', 3320, '84.128.0.0/24'));

  it('geofence removes every untagged answer (incl. Réalta) once a geo-tag matches', () => {
    expect(removedAt(r, 'geofence_country')).toEqual(
      expect.arrayContaining(['main-realta', 'eir-realta', 'fastly-allother', 'prefix-realta']),
    );
    expect(share(r, 'Réalta')).toBe(0);
    expect(share(r, 'Akamai')).toBeCloseTo(0.5, 5);
    expect(share(r, 'Fastly')).toBeCloseTo(0.5, 5);
  });
});

describe('no ASN match → untagged remain, then prefix fence selects the tagged prefix answer', () => {
  const r = evaluate(record, scen('IE', 99999, '203.0.113.7/32'));

  it('keeps untagged fallbacks at netfence_asn (no tagged ASN matched)', () => {
    expect(removedAt(r, 'netfence_asn')).not.toEqual(expect.arrayContaining(['fastly-allother', 'akamai-allother']));
  });

  it('netfence_prefix then drops the untagged fallbacks because the prefix answer matched', () => {
    expect(removedAt(r, 'netfence_prefix')).toEqual(expect.arrayContaining(['fastly-allother', 'akamai-allother']));
    expect(r.selected).toBe('prefix-realta');
    expect(r.selectionDeterminism).toBe('context_dependent'); // one survivor, no shuffle over >1; hinges on ASN/prefix
    expect(share(r, 'Réalta')).toBeCloseTo(1, 5);
  });
});

describe('without the remove_no_* flag, untagged answers are retained (fallback semantics)', () => {
  it('keeps "all other" answers when netfence_asn has no remove_no_asn', () => {
    const noFlag: NS1Record = {
      ...record,
      filters: record.filters.map((f) => (f.filter === 'netfence_asn' ? { filter: 'netfence_asn', config: {} } : f)),
    };
    const r = evaluate(noFlag, scen('IE', 100, '198.51.100.0/24'));
    expect(removedAt(r, 'netfence_asn')).not.toEqual(expect.arrayContaining(['fastly-allother', 'akamai-allother']));
  });
});

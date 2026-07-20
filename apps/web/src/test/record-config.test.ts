import { describe, it, expect } from 'vitest';
import { platformOf } from '../steering/platforms';
import {
  ISO_ALPHA2, asnList, countryList, countryName, filterMeta, summariseCountries, weightShares,
} from '../steering/record-config';

describe('platformOf (RDATA → delivery platform)', () => {
  it('derives the RTÉ multi-CDN platforms from the answer hostname', () => {
    expect(platformOf('liveedge.rte.ie')).toBe('Réalta');
    expect(platformOf('t.sni.global.fastly.net')).toBe('Fastly');
    // Ends in akamaized.net despite containing "rte.ie" — the suffix decides, so it's Akamai.
    expect(platformOf('live.rte.ie.akamaized.net')).toBe('Akamai');
    expect(platformOf('d3k5dscs9b55g6.cloudfront.net')).toBe('CloudFront');
    expect(platformOf('example.unknown-cdn.com')).toBeNull();
  });
});

describe('countryName / summariseCountries', () => {
  it('translates codes to names', () => {
    expect(countryName('IE')).toBe('Ireland');
    expect(countryName('GB')).toBe('United Kingdom');
    expect(typeof countryName('QM')).toBe('string'); // unknown code → graceful (never throws)
  });

  it('summarises a near-complete list as "all countries except …"', () => {
    const allButIeGb = ISO_ALPHA2.filter((c) => c !== 'IE' && c !== 'GB');
    const s = summariseCountries(allButIeGb);
    expect(s.excluded).toEqual(expect.arrayContaining(['IE', 'GB']));
    expect(s.excluded).toHaveLength(2);
    expect(s.phrase).toMatch(/^All countries except/);
    expect(s.phrase).toContain('Ireland');
    expect(s.phrase).toContain('United Kingdom');
  });

  it('summarises a short list by name/count', () => {
    expect(summariseCountries(['IE', 'GB']).phrase).toBe('Ireland, United Kingdom');
    expect(summariseCountries(['IE']).excluded).toBeNull();
  });
});

describe('filterMeta', () => {
  it('describes supported filters and flags unsupported ones', () => {
    expect(filterMeta('netfence_asn')).toMatchObject({ label: 'Netfence ASN', behaviour: 'eliminate', supported: true });
    expect(filterMeta('select_first_n').supported).toBe(true);
    expect(filterMeta('shed_load').supported).toBe(false);
    expect(filterMeta('totally_unknown')).toMatchObject({ supported: false, behaviour: 'unknown' });
  });
});

describe('meta extraction + weight shares', () => {
  it('reads asn/country as scalar or array, ignoring feed pointers', () => {
    expect(asnList({ asn: [5466, 15502] })).toEqual([5466, 15502]);
    expect(asnList({ asn: 5466 })).toEqual([5466]);
    expect(asnList({ asn: { feed: 'x' } })).toEqual([]);
    expect(countryList({ country: 'IE' })).toEqual(['IE']);
    expect(countryList({ country: ['IE', 'GB'] })).toEqual(['IE', 'GB']);
  });

  it('computes each answer\'s share of total weight', () => {
    const out = weightShares([{ weight: 400 }, { weight: 400 }, { weight: 40 }, { weight: 0 }]);
    expect(out[0].share).toBeCloseTo(400 / 840, 5);
    expect(out[3].share).toBe(0); // zero-weight answers take no share
    expect(out.reduce((s, i) => s + i.share, 0)).toBeCloseTo(1, 5);
  });
});

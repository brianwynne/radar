import { describe, it, expect } from 'vitest';
import { platformOf } from '../steering/platforms';
import {
  ISO_ALPHA2, asnList, countryList, countryName, filterMeta, removeFlagFor, summariseCountries, weightShares,
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

  it("carries NS1's filter category and recognises the full catalogue", () => {
    expect(filterMeta('netfence_asn').category).toBe('Fencing');
    expect(filterMeta('geotarget_country').category).toBe('Geographic');
    expect(filterMeta('weighted_shuffle').category).toBe('Traffic Management');
    expect(filterMeta('up').category).toBe('Health checks');
    expect(filterMeta('pulsar_performance_sort').category).toBe('Pulsar');
    // Newly-catalogued types are recognised (not "unknown"), even if RADAR can't evaluate them yet.
    expect(filterMeta('weighted_sticky_shuffle').behaviour).not.toBe('unknown');
    expect(filterMeta('cost').label).toBe('Cost');
    expect(filterMeta('totally_unknown').category).toBeNull();
  });

  it("carries NS1's verbatim description ONLY for the filters captured from NS1", () => {
    // Provided by NS1 → verbatim text present.
    expect(filterMeta('netfence_asn').ns1Description).toMatch(/Autonomous System \(AS\)/);
    expect(filterMeta('netfence_prefix').ns1Description).toMatch(/ip_prefixes metadata field/);
    expect(filterMeta('weighted_shuffle').ns1Description).toMatch(/weight metadata field/);
    expect(filterMeta('select_first_n').ns1Description).toMatch(/eliminates all but the first N/);
    // Not captured from NS1 → no fabricated NS1 text, only RADAR's summary.
    expect(filterMeta('geofence_country').ns1Description).toBeUndefined();
    expect(filterMeta('up').ns1Description).toBeUndefined();
    expect(filterMeta('geofence_country').summary).toBeTruthy();
  });
});

describe('removeFlagFor (reads the actual filter config, never assumes)', () => {
  it('reflects the remove-untagged flag state from config', () => {
    expect(removeFlagFor('netfence_asn', { remove_no_asn: '1' })).toMatchObject({ enabled: true, explainSource: 'ns1' });
    expect(removeFlagFor('netfence_asn', {})?.enabled).toBe(false);
    expect(removeFlagFor('netfence_asn', undefined)?.enabled).toBe(false);
    expect(removeFlagFor('netfence_prefix', { remove_no_ip_prefixes: true })?.enabled).toBe(true);
    expect(removeFlagFor('geofence_country', { remove_no_location: '1' })).toMatchObject({ enabled: true, explainSource: 'radar' });
    expect(removeFlagFor('weighted_shuffle', {})).toBeNull(); // not a fence filter
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

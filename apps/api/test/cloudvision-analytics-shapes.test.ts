// Pure parsers for the CloudVision analytics wire shapes: value unwrapping, rate/utilisation
// parsing, speed derivation, and BGP description → provider/type. Absent/malformed → null,
// never a fabricated value.
import { describe, it, expect } from 'vitest';
import {
  num, rateAvg, str, bgpStateName, parseInterfaceRates, parseUtilisation, speedFromUtilisation,
  parseBgpPeer, parseBgpDescription,
} from '../src/cloudvision/analytics-shapes.js';

const wrap = (value: unknown) => ({ key: 'k', value });
const stat = (avg: number) => wrap({ avg: { float: avg }, max: { float: avg }, min: { float: avg }, stddev: { float: 0 }, weight: { float: 1 } });

describe('value unwrapping', () => {
  it('num handles plain, {int}, {float}, and nested {value:{int}}', () => {
    expect(num(wrap({ int: 5466 }))).toBe(5466);
    expect(num(wrap({ float: 6.17 }))).toBeCloseTo(6.17);
    expect(num(wrap({ value: { int: 174 } }))).toBe(174); // BGP ASN shape
    expect(num(wrap('nope'))).toBeNull();
    expect(num(undefined)).toBeNull();
  });
  it('rateAvg takes the avg of a rate-stats object', () => {
    expect(rateAvg(stat(1000))).toBe(1000);
    expect(rateAvg(wrap({ notavg: 1 }))).toBeNull();
  });
  it('str / bgpStateName', () => {
    expect(str(wrap('hello'))).toBe('hello');
    expect(str(wrap({ x: 1 }))).toBeNull();
    expect(bgpStateName(wrap({ Name: 'Established', Value: { int: 6 } }))).toBe('Established');
    expect(bgpStateName(wrap({ noname: 1 }))).toBeNull();
  });
});

describe('parseInterfaceRates', () => {
  it('normal: octet rates ×8 = bps; errors/discards present', () => {
    const r = parseInterfaceRates({ inOctets: stat(1e9), outOctets: stat(5e9), inErrors: stat(0), outErrors: stat(2), inDiscards: stat(0), outDiscards: stat(3) });
    expect(r.inBps).toBe(8e9);
    expect(r.outBps).toBe(40e9);
    expect(r.outErrors).toBe(2);
    expect(r.outDiscards).toBe(3);
  });
  it('empty result → all null', () => {
    expect(parseInterfaceRates({})).toMatchObject({ inBps: null, outBps: null });
  });
  it('partial: rate present but a counter missing → that field null, others intact', () => {
    const r = parseInterfaceRates({ outOctets: stat(2e9) }); // no inOctets, no errors
    expect(r.outBps).toBe(16e9);
    expect(r.inBps).toBeNull();
    expect(r.inErrors).toBeNull();
  });
  it('malformed row → null (no throw)', () => {
    expect(parseInterfaceRates({ outOctets: wrap('garbage') }).outBps).toBeNull();
  });
});

describe('parseUtilisation + speedFromUtilisation', () => {
  it('reads pre-computed utilisation %', () => {
    expect(parseUtilisation({ 'inOctets-utilization': wrap({ float: 8 }), 'outOctets-utilization': wrap({ float: 40 }) })).toEqual({ inPercent: 8, outPercent: 40 });
  });
  it('derives speed = bps / (util/100)', () => {
    expect(speedFromUtilisation(40e9, 40)).toBeCloseTo(100e9, -6); // 40 Gbps at 40% → 100 Gbps
    expect(speedFromUtilisation(40e9, 0)).toBeNull(); // cannot divide by ~0
    expect(speedFromUtilisation(null, 40)).toBeNull();
  });
});

describe('parseBgpDescription', () => {
  it('extracts provider + link-type from a tagged description', () => {
    expect(parseBgpDescription('[Transit] Cogent 3-002188930')).toEqual({ provider: 'Cogent', linkTypeHint: 'TRANSIT' });
    expect(parseBgpDescription('[Peering] Eir')).toEqual({ provider: 'Eir', linkTypeHint: 'PRIVATE_PEERING' });
    expect(parseBgpDescription('[IX] INEX route-server')).toEqual({ provider: 'INEX', linkTypeHint: 'IX_PEERING' });
  });
  it('untagged description → provider from first token, no link-type', () => {
    expect(parseBgpDescription('Blacknight')).toEqual({ provider: 'Blacknight', linkTypeHint: null });
  });
  it('null description → nothing (never fabricated)', () => {
    expect(parseBgpDescription(null)).toEqual({ provider: null, linkTypeHint: null });
  });
});

describe('parseBgpPeer', () => {
  it('parses a full peer leaf', () => {
    const p = parseBgpPeer({ bgpState: wrap({ Name: 'Established', Value: { int: 6 } }), bgpPeerAs: wrap({ value: { int: 174 } }), bgpPeerLocalAddr: wrap('10.0.0.1'), bgpPeerDescription: wrap('[Transit] Cogent'), intfId: wrap('Ethernet2/1') });
    expect(p).toMatchObject({ asn: 174, state: 'Established', localAddr: '10.0.0.1', provider: 'Cogent', linkTypeHint: 'TRANSIT', intfId: 'Ethernet2/1' });
  });
  it('empty leaf → all null', () => {
    expect(parseBgpPeer({})).toMatchObject({ asn: null, state: null, provider: null });
  });
});

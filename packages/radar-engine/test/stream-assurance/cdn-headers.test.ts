import { describe, it, expect } from 'vitest';
import { parseAkamaiHeaders, parseFastlyHeaders, parseRealtaHeaders, parseCdnHeaders } from '../../src/stream-assurance/index.js';

describe('CDN header adapters', () => {
  it('Akamai: edge + parent both MISS ⇒ fetchedFromOrigin', () => {
    const o = parseAkamaiHeaders({ 'X-Cache': 'TCP_MISS from edge1', 'X-Cache-Remote': 'TCP_MISS from parent1', Age: '0' });
    expect(o.edge).toBe('miss');
    expect(o.parent).toBe('miss');
    expect(o.fetchedFromOrigin).toBe(true);
    expect(o.age).toBe(0);
  });

  it('Akamai: edge HIT ⇒ not from origin', () => {
    const o = parseAkamaiHeaders({ 'X-Cache': 'TCP_HIT from edge1' });
    expect(o.edge).toBe('hit');
    expect(o.fetchedFromOrigin).toBe(false);
  });

  it('Akamai: origin identity from a configured header', () => {
    const o = parseAkamaiHeaders({ 'X-Cache': 'TCP_MISS', 'X-RTE-Origin': 'live-origin-1' });
    expect(o.originIdentity).toBe('live-origin-1');
  });

  it('Fastly: multi-node X-Cache — last node is the edge', () => {
    const o = parseFastlyHeaders({ 'X-Cache': 'MISS, HIT', 'X-Served-By': 'cache-dub-x, cache-lhr-y', Age: '12' });
    expect(o.parent).toBe('miss'); // node nearest origin
    expect(o.edge).toBe('hit'); // node nearest client
    expect(o.fetchedFromOrigin).toBe(false);
    expect(o.servedBy).toBe('cache-lhr-y');
    expect(o.age).toBe(12);
  });

  it('Fastly: single-node MISS ⇒ fetchedFromOrigin', () => {
    const o = parseFastlyHeaders({ 'X-Cache': 'MISS' });
    expect(o.edge).toBe('miss');
    expect(o.fetchedFromOrigin).toBe(true);
  });

  it('Réalta: reads X-Cache (Varnish/ATS style)', () => {
    const o = parseRealtaHeaders({ 'X-Cache': 'HIT', Age: '3' });
    expect(o.cdn).toBe('realta');
    expect(o.edge).toBe('hit');
    expect(o.age).toBe(3);
  });

  it('Réalta: reads nginx X-Cache-Status and RFC 9211 Cache-Status', () => {
    expect(parseRealtaHeaders({ 'X-Cache-Status': 'MISS' }).edge).toBe('miss');
    expect(parseRealtaHeaders({ 'Cache-Status': '"realta-edge-1"; hit' }).edge).toBe('hit');
    expect(parseRealtaHeaders({ 'Cache-Status': '"realta-edge-1"; fwd=miss' }).edge).toBe('miss');
  });

  it('Réalta: edge MISS with no parent HIT ⇒ fetchedFromOrigin; no cache header ⇒ unknown', () => {
    expect(parseRealtaHeaders({ 'X-Cache': 'MISS' }).fetchedFromOrigin).toBe(true);
    const none = parseRealtaHeaders({ Server: 'realta' });
    expect(none.edge).toBe('unknown');
    expect(none.fetchedFromOrigin).toBe(false);
  });

  it('parseCdnHeaders dispatches by provider', () => {
    expect(parseCdnHeaders('akamai', { 'X-Cache': 'TCP_HIT' }).cdn).toBe('akamai');
    expect(parseCdnHeaders('fastly', { 'X-Cache': 'HIT' }).cdn).toBe('fastly');
    expect(parseCdnHeaders('realta', { 'X-Cache': 'HIT' }).cdn).toBe('realta');
    expect(parseCdnHeaders('origin', {}).fetchedFromOrigin).toBe(true);
  });
});

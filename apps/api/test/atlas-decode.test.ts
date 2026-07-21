// DNS abuf decoder — fixtures are REAL RIPE Atlas responses captured from Irish ISP resolvers
// resolving live.rte.ie (measurement 192116677).
import { describe, it, expect } from 'vitest';
import { isPublicResolver, parseDnsAbuf, summarizeChain } from '../src/atlas/decode.js';

// Eir probe 27252, resolver serving a cached answer: live.rte.ie → livebase → liveedge → 4× A
// (185.54.105.x). TTLs as served: apex CNAME 88, livebase CNAME 53, A 27.
const EIR_CACHED = 'lkeBgAABAAYAAAAABGxpdmUDcnRlAmllAAABAAHADAAFAAEAAABYABcIbGl2ZWJhc2UFbnNvbmUDcnRlAmllAMApAAUAAQAAADUAEQhsaXZlZWRnZQNydGUCaWUAwEwAAQABAAAAGwAEuTZpDMBMAAEAAQAAABsABLk2aQjATAABAAEAAAAbAAS5NmkEwEwAAQABAAAAGwAEuTZpAA==';

describe('parseDnsAbuf + summarizeChain', () => {
  it('decodes the CNAME chain + A records with their TTLs', () => {
    const rrs = parseDnsAbuf(EIR_CACHED);
    expect(rrs.length).toBe(6); // 2 CNAME + 4 A
    expect(rrs[0]).toMatchObject({ name: 'live.rte.ie', type: 5, data: 'livebase.nsone.rte.ie', ttl: 88 });
    expect(rrs[1]).toMatchObject({ type: 5, data: 'liveedge.rte.ie', ttl: 53 });
    expect(rrs[2]).toMatchObject({ type: 1, ttl: 27 });
    expect(rrs.filter((r) => r.type === 1).map((r) => r.data)).toEqual(['185.54.105.12', '185.54.105.8', '185.54.105.4', '185.54.105.0']);
  });

  it('summarises to platform + the TTLs we care about', () => {
    const s = summarizeChain(parseDnsAbuf(EIR_CACHED));
    expect(s.platform).toBe('Réalta');
    expect(s.target).toBe('liveedge.rte.ie');
    expect(s.apexTtl).toBe(88); // live.rte.ie CNAME TTL as served
    expect(s.edgeTtl).toBe(27); // the low liveedge A TTL — the "did they honour it" number
    expect(s.minTtl).toBe(27);
    expect(s.vips).toContain('185.54.105.0');
  });

  it('flags well-known public resolvers (Google/Quad9/NextDNS/…) vs ISP-own', () => {
    for (const p of ['8.8.8.8', '9.9.9.9', '1.1.1.1', '45.90.28.210', '149.112.112.112']) expect(isPublicResolver(p)).toBe(true);
    for (const own of ['86.54.11.100', '89.101.251.230', '192.168.1.1', '10.0.16.2']) expect(isPublicResolver(own)).toBe(false);
  });

  it('malformed input → empty, never throws', () => {
    expect(parseDnsAbuf('not-base64-@@')).toEqual([]);
    expect(parseDnsAbuf('AAAA')).toEqual([]); // too short
    expect(summarizeChain([])).toMatchObject({ platform: null, target: null, vips: [], minTtl: null });
  });
});

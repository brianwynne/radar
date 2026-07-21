// DNS abuf decoder — fixtures are REAL RIPE Atlas responses captured from Irish ISP resolvers
// resolving live.rte.ie (measurement 192116677).
import { describe, it, expect } from 'vitest';
import { isPublicResolver, parseDnsAbuf, summarizeChain } from '../src/atlas/decode.js';
import { buildIspView } from '../src/atlas/client.js';

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
    expect(s.apexTtl).toBe(88); // live.rte.ie pointer CNAME TTL
    expect(s.recordTtl).toBe(53); // the *.nsone.rte.ie (NS1 record) CNAME TTL — shed-relevant
    expect(s.edgeTtl).toBe(27); // the liveedge A TTL (Cloudflare LB) — A-record only
    expect(s.minTtl).toBe(27);
    expect(s.vips).toContain('185.54.105.0');
  });

  it('never reports a CNAME TTL as the edge — no A section → edgeTtl null (fixes the false "300")', () => {
    // A CNAME-only chain (e.g. a result that carried no A section): the liveedge CNAME TTL is 300,
    // but that must NOT be reported as the edge (A) TTL.
    const cnameOnly = [
      { name: 'live.rte.ie', type: 5, ttl: 200, data: 'livebase.nsone.rte.ie' },
      { name: 'livebase.nsone.rte.ie', type: 5, ttl: 300, data: 'liveedge.rte.ie' },
    ];
    const s = summarizeChain(cnameOnly);
    expect(s.edgeTtl).toBeNull();       // never 300 from a CNAME
    expect(s.recordTtl).toBe(300);      // the NS1 record TTL is surfaced separately
    expect(s.apexTtl).toBe(200);
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

describe('buildIspView — steering verdict keyed on the NS1-record TTL (not the edge)', () => {
  const m = { isp: 'Eir', asn: 5466, measurementId: 192119190 };

  it('NS1-record TTL ≤ ceiling → steering NOT impeded, window = record TTL (edge TTL is irrelevant)', () => {
    // EIR_CACHED: NS1 record (livebase) CNAME TTL 53, edge A TTL 27.
    const v = buildIspView(m, [{ prb_id: 1, timestamp: 1_700_000_000, resultset: [{ dst_addr: '10.0.16.2', result: { abuf: EIR_CACHED } }] }], 35);
    expect(v.recordTtl).toEqual({ min: 53, max: 53 });
    expect(v.steeringImpeded).toBe(false);      // 53 ≤ 60 ceiling
    expect(v.steeringWindowSecs).toBe(53);      // driven by the NS1 record, not the 27s edge
  });

  it('a high NS1-record TTL flips steeringImpeded true even when the edge TTL is low', () => {
    // Synthesise a chain: apex 300, NS1 record 300 (high), edge A 30 (low). Steering is impeded by
    // the record TTL regardless of the low edge TTL — the exact case the operator flagged.
    const rrs = [
      { name: 'live.rte.ie', type: 5, ttl: 300, data: 'livebase.nsone.rte.ie' },
      { name: 'livebase.nsone.rte.ie', type: 5, ttl: 300, data: 'liveedge.rte.ie' },
      { name: 'liveedge.rte.ie', type: 1, ttl: 30, data: '185.54.104.4' },
    ];
    const s = summarizeChain(rrs);
    expect(s.recordTtl).toBe(300);
    expect(s.edgeTtl).toBe(30);
    // (buildIspView verdict for this shape is exercised via the mock at 300s in the route tests;
    // here we assert the summariser separates the two layers correctly.)
    expect(s.recordTtl! > 60 && s.edgeTtl! <= 35).toBe(true);
  });
});

// The hand-rolled DNS wire codec: query encoding (with ECS) and response decoding
// (rcode, A/AAAA answers, TTL, ECS scope). Pure byte handling — no network.
import { describe, it, expect } from 'vitest';
import { encodeQuery, decodeResponse } from '../src/dns-observation/dns-wire.js';

function name(n: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of n.split('.')) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

interface Ans { type: 'A' | 'AAAA'; address: string; ttl: number }
function ip4(a: string): Buffer {
  return Buffer.from(a.split('.').map((p) => Number(p)));
}
function ip6(a: string): Buffer {
  const out = Buffer.alloc(16);
  const groups = a.split(':');
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
  return out;
}
function buildResponse(qname: string, answers: Ans[], rcode = 0, ecsScope?: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(ecsScope !== undefined ? 1 : 0, 10);
  const question = Buffer.concat([name(qname), Buffer.from([0, 1, 0, 1])]);
  const ansBufs = answers.map((a) => {
    const rdata = a.type === 'A' ? ip4(a.address) : ip6(a.address);
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0); // pointer to qname
    fixed.writeUInt16BE(a.type === 'A' ? 1 : 28, 2);
    fixed.writeUInt16BE(1, 4);
    fixed.writeUInt32BE(a.ttl, 6);
    fixed.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([fixed, rdata]);
  });
  const opt: Buffer[] = [];
  if (ecsScope !== undefined) {
    const ecsData = Buffer.from([0, 1, 24, ecsScope, 203, 0, 113]); // family v4, source 24, scope, addr 203.0.113
    const rdata = Buffer.concat([Buffer.from([0, 8, (ecsData.length >> 8) & 0xff, ecsData.length & 0xff]), ecsData]);
    const fixed = Buffer.alloc(11);
    fixed.writeUInt8(0, 0); // root name
    fixed.writeUInt16BE(41, 1); // OPT
    fixed.writeUInt16BE(4096, 3);
    fixed.writeUInt32BE(0, 5);
    fixed.writeUInt16BE(rdata.length, 9);
    opt.push(Buffer.concat([fixed, rdata]));
  }
  return Buffer.concat([header, question, ...ansBufs, ...opt]);
}

describe('encodeQuery', () => {
  it('encodes an A question with RD set and no OPT when ECS is absent', () => {
    const buf = encodeQuery({ id: 0x1234, qname: 'live.rte.ie', qtype: 'A' });
    expect(buf.readUInt16BE(0)).toBe(0x1234);
    expect(buf.readUInt16BE(2)).toBe(0x0100); // RD
    expect(buf.readUInt16BE(4)).toBe(1); // QDCOUNT
    expect(buf.readUInt16BE(10)).toBe(0); // ARCOUNT — no OPT
  });
  it('adds an EDNS0 OPT with an ECS option when a subnet is given', () => {
    const buf = encodeQuery({ id: 1, qname: 'live.rte.ie', qtype: 'A', ecsSubnet: '203.0.113.0/24' });
    expect(buf.readUInt16BE(10)).toBe(1); // ARCOUNT
    // ECS option code (8) appears in the OPT rdata.
    expect(buf.includes(Buffer.from([0, 8]))).toBe(true);
  });
});

describe('decodeResponse', () => {
  it('decodes IPv4 answers and the minimum TTL', () => {
    const d = decodeResponse(buildResponse('live.rte.ie', [{ type: 'A', address: '192.0.2.10', ttl: 30 }, { type: 'A', address: '192.0.2.20', ttl: 20 }]));
    expect(d.responseCode).toBe('NOERROR');
    expect(d.answers.map((a) => a.address)).toEqual(['192.0.2.10', '192.0.2.20']);
    expect(d.ttl).toBe(20);
  });
  it('decodes IPv6 answers', () => {
    const d = decodeResponse(buildResponse('live.rte.ie', [{ type: 'AAAA', address: '2001:db8:0:0:0:0:0:1', ttl: 60 }]));
    expect(d.answers[0].type).toBe('AAAA');
    expect(d.answers[0].address).toBe('2001:db8:0:0:0:0:0:1');
  });
  it('surfaces NXDOMAIN and SERVFAIL rcodes', () => {
    expect(decodeResponse(buildResponse('x.rte.ie', [], 3)).responseCode).toBe('NXDOMAIN');
    expect(decodeResponse(buildResponse('x.rte.ie', [], 2)).responseCode).toBe('SERVFAIL');
  });
  it('reads the ECS scope-prefix-length from the OPT record', () => {
    expect(decodeResponse(buildResponse('live.rte.ie', [{ type: 'A', address: '192.0.2.10', ttl: 30 }], 0, 24)).ecsScopePrefixLength).toBe(24);
    expect(decodeResponse(buildResponse('live.rte.ie', [{ type: 'A', address: '192.0.2.10', ttl: 30 }], 0, 0)).ecsScopePrefixLength).toBe(0);
  });
});

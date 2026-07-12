// Minimal, dependency-free DNS wire codec: encode a single A/AAAA question with an optional
// EDNS0 Client-Subnet (ECS) OPT record, and decode a response's rcode, A/AAAA answers, TTL,
// and ECS scope. This is the ONLY hand-rolled protocol code; it is deliberately narrow
// (RADAR only needs A/AAAA + ECS for read-only observation) and is exercised by unit tests.
// It never executes anything — it only reads/writes bytes.
import type { DnsResponseCode, ObservedAnswer } from './types.js';

const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_OPT = 41;
const CLASS_IN = 1;
const ECS_OPTION_CODE = 8;

const RCODES: Record<number, DnsResponseCode> = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 5: 'REFUSED' };

function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.').filter((l) => l.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length > 63) throw new Error('DNS label too long');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0])); // root
  return Buffer.concat(parts);
}

/** Parse a CIDR into { family, sourcePrefix, addressBytes } for the ECS option. */
function encodeEcs(cidr: string): Buffer {
  const [addr, prefixStr] = cidr.split('/');
  const sourcePrefix = Number(prefixStr);
  const isV6 = addr.includes(':');
  const family = isV6 ? 2 : 1;
  const full = isV6 ? ipv6ToBytes(addr) : ipv4ToBytes(addr);
  const addrLen = Math.ceil(sourcePrefix / 8);
  const address = full.subarray(0, addrLen);
  const optionData = Buffer.concat([
    Buffer.from([(family >> 8) & 0xff, family & 0xff, sourcePrefix & 0xff, 0]), // family, source-prefix, scope=0
    address,
  ]);
  const header = Buffer.from([
    (ECS_OPTION_CODE >> 8) & 0xff, ECS_OPTION_CODE & 0xff,
    (optionData.length >> 8) & 0xff, optionData.length & 0xff,
  ]);
  return Buffer.concat([header, optionData]);
}

function ipv4ToBytes(ip: string): Buffer {
  const parts = ip.split('.').map((p) => Number(p) & 0xff);
  if (parts.length !== 4) throw new Error('Invalid IPv4');
  return Buffer.from(parts);
}
function bytesToIpv4(b: Buffer): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}
function ipv6ToBytes(ip: string): Buffer {
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':').filter((g) => g.length > 0) : [];
  const tailGroups = tail ? tail.split(':').filter((g) => g.length > 0) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(Math.max(0, missing)).fill('0'), ...tailGroups];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16) & 0xffff;
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}
function bytesToIpv6(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return groups.join(':');
}

export interface EncodeOptions {
  id: number;
  qname: string;
  qtype: 'A' | 'AAAA';
  ecsSubnet?: string;
}

export function encodeQuery(opts: EncodeOptions): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id & 0xffff, 0);
  header.writeUInt16BE(0x0100, 2); // RD=1
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(opts.ecsSubnet ? 1 : 0, 10); // ARCOUNT (OPT)

  const question = Buffer.concat([
    encodeName(opts.qname),
    Buffer.from([0, opts.qtype === 'AAAA' ? TYPE_AAAA : TYPE_A, 0, CLASS_IN]),
  ]);

  if (!opts.ecsSubnet) return Buffer.concat([header, question]);

  const rdata = encodeEcs(opts.ecsSubnet);
  const opt = Buffer.concat([
    Buffer.from([0]), // root name
    Buffer.from([(TYPE_OPT >> 8) & 0xff, TYPE_OPT & 0xff]),
    Buffer.from([0x10, 0x00]), // UDP payload size 4096
    Buffer.from([0, 0, 0, 0]), // extended rcode + flags
    Buffer.from([(rdata.length >> 8) & 0xff, rdata.length & 0xff]),
    rdata,
  ]);
  return Buffer.concat([header, question, opt]);
}

/** Advance past a DNS name at `off`, returning the next offset. Follows the standard
 *  length-prefixed labels and terminates on a compression pointer (0xC0) or a zero label. */
function skipName(buf: Buffer, off: number): number {
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2; // pointer — name ends
    off += len + 1;
  }
  return off;
}

export interface DecodedResponse {
  responseCode: DnsResponseCode;
  answers: ObservedAnswer[];
  ttl?: number;
  ecsScopePrefixLength?: number;
}

export function decodeResponse(buf: Buffer): DecodedResponse {
  if (buf.length < 12) return { responseCode: 'FORMERR', answers: [] };
  const flags = buf.readUInt16BE(2);
  const rcode = RCODES[flags & 0x0f] ?? 'OTHER';
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);

  let off = 12;
  for (let i = 0; i < qd; i++) off = skipName(buf, off) + 4; // + QTYPE + QCLASS

  const answers: ObservedAnswer[] = [];
  let minTtl: number | undefined;
  const readRr = (collect: boolean, opt: { scope?: number }) => {
    off = skipName(buf, off);
    if (off + 10 > buf.length) { off = buf.length; return; }
    const type = buf.readUInt16BE(off);
    const ttl = buf.readUInt32BE(off + 4);
    const rdlength = buf.readUInt16BE(off + 8);
    const rdstart = off + 10;
    if (collect && type === TYPE_A && rdlength === 4) {
      answers.push({ type: 'A', address: bytesToIpv4(buf.subarray(rdstart, rdstart + 4)) });
      minTtl = minTtl === undefined ? ttl : Math.min(minTtl, ttl);
    } else if (collect && type === TYPE_AAAA && rdlength === 16) {
      answers.push({ type: 'AAAA', address: bytesToIpv6(buf.subarray(rdstart, rdstart + 16)) });
      minTtl = minTtl === undefined ? ttl : Math.min(minTtl, ttl);
    } else if (type === TYPE_OPT) {
      // Parse OPT rdata for an ECS option to read the scope-prefix-length.
      let p = rdstart;
      const end = rdstart + rdlength;
      while (p + 4 <= end) {
        const optCode = buf.readUInt16BE(p);
        const optLen = buf.readUInt16BE(p + 2);
        if (optCode === ECS_OPTION_CODE && optLen >= 4) opt.scope = buf[p + 4 + 3]; // FAMILY(2)+SOURCE(1)+SCOPE(1)
        p += 4 + optLen;
      }
    }
    off = rdstart + rdlength;
  };

  const optState: { scope?: number } = {};
  for (let i = 0; i < an; i++) readRr(true, optState);
  for (let i = 0; i < ns; i++) readRr(false, optState);
  for (let i = 0; i < ar; i++) readRr(false, optState);

  return { responseCode: rcode, answers, ttl: minTtl, ecsScopePrefixLength: optState.scope };
}

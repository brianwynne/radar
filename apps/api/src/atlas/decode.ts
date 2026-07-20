// Minimal DNS message parser for RIPE Atlas DNS `abuf` — the base64-encoded wire-format response
// a probe's resolver returned. Extracts the answer RRs (CNAME chain + A records) with their TTLs.
// Pure and total: a malformed buffer yields [] rather than throwing, so one bad probe can't break
// the aggregate. We only need CNAME (5) and A (1); other types are captured as opaque so offsets
// stay correct.

export interface DnsRR {
  name: string;
  type: number;
  ttl: number;
  /** CNAME target, A dotted-quad, or `type<N>` for anything we don't decode. */
  data: string;
}

/** Decode a base64 DNS response → its answer records, in order. */
export function parseDnsAbuf(b64: string): DnsRR[] {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return [];
  }
  if (buf.length < 12) return [];
  let p = 0;
  // Read a (possibly compressed) domain name starting at `p`, advancing `p` past it unless a
  // pointer was followed (then p resumes after the pointer, RFC 1035 §4.1.4).
  const readName = (): string => {
    const parts: string[] = [];
    let jumped = false;
    let resume = 0;
    let guard = 0;
    while (guard++ < 128) {
      if (p >= buf.length) break;
      const len = buf[p];
      if (len === 0) {
        if (!jumped) p++;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        if (p + 1 >= buf.length) break;
        const off = ((len & 0x3f) << 8) | buf[p + 1];
        if (!jumped) resume = p + 2;
        p = off;
        jumped = true;
        continue;
      }
      p++;
      parts.push(buf.subarray(p, p + len).toString('latin1'));
      p += len;
    }
    if (jumped) p = resume;
    return parts.join('.');
  };

  try {
    const ancount = buf.readUInt16BE(6);
    p = 12;
    readName(); // question QNAME
    p += 4; // QTYPE + QCLASS
    const rrs: DnsRR[] = [];
    for (let i = 0; i < ancount && p < buf.length; i++) {
      const name = readName();
      const type = buf.readUInt16BE(p);
      p += 2; // TYPE
      p += 2; // CLASS
      const ttl = buf.readUInt32BE(p);
      p += 4;
      const rdlength = buf.readUInt16BE(p);
      p += 2;
      let data: string;
      if (type === 5) {
        const start = p;
        data = readName();
        p = start + rdlength; // CNAME rdata may use compression; realign to declared length
      } else if (type === 1 && rdlength === 4) {
        data = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
        p += rdlength;
      } else {
        data = `type${type}`;
        p += rdlength;
      }
      rrs.push({ name, type, ttl, data });
    }
    return rrs;
  } catch {
    return [];
  }
}

export interface ChainSummary {
  /** Delivery platform derived from the final target (Réalta / Fastly / Akamai / CloudFront). */
  platform: string | null;
  /** The delivery hostname the chain resolved to (last CNAME before the A records). */
  target: string | null;
  /** The A-record addresses returned (the pool/VIPs). */
  vips: string[];
  /** TTL on the first CNAME (the queried apex, e.g. live.rte.ie) as the resolver served it. */
  apexTtl: number | null;
  /** TTL on the final A record — the low, fast-changing edge TTL (the "will they honour it" one). */
  edgeTtl: number | null;
  /** Smallest TTL anywhere in the chain. */
  minTtl: number | null;
  /** Every hop, for the drill-down. */
  hops: { name: string; type: 'CNAME' | 'A'; ttl: number; data: string }[];
}

const platformOf = (host: string): string | null => {
  const h = host.toLowerCase();
  if (/(^|\.)rte\.ie$/.test(h) || /^185\.54\.10[0-9]\./.test(h)) return 'Réalta';
  if (/fastly/.test(h)) return 'Fastly';
  if (/akamai/.test(h)) return 'Akamai';
  if (/cloudfront/.test(h)) return 'CloudFront';
  return null;
};

/** Summarise a decoded chain into platform + the TTLs we care about. */
export function summarizeChain(rrs: DnsRR[]): ChainSummary {
  const hops = rrs
    .filter((r) => r.type === 5 || r.type === 1)
    .map((r) => ({ name: r.name, type: (r.type === 5 ? 'CNAME' : 'A') as 'CNAME' | 'A', ttl: r.ttl, data: r.data }));
  const cnames = hops.filter((h) => h.type === 'CNAME');
  const aRecords = hops.filter((h) => h.type === 'A');
  const target = cnames.length ? cnames[cnames.length - 1].data : (aRecords[0]?.name ?? null);
  const platform = target ? platformOf(target) : aRecords.length ? platformOf(aRecords[0].data) : null;
  const ttls = hops.map((h) => h.ttl);
  return {
    platform,
    target,
    vips: aRecords.map((a) => a.data),
    apexTtl: cnames[0]?.ttl ?? aRecords[0]?.ttl ?? null,
    edgeTtl: aRecords.length ? aRecords[0].ttl : (cnames[cnames.length - 1]?.ttl ?? null),
    minTtl: ttls.length ? Math.min(...ttls) : null,
    hops,
  };
}

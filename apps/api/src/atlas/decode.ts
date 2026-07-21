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
      } else if (type === 16) {
        // TXT: one or more <len><bytes> character-strings within rdlength (e.g. "ns 2001:…").
        const end = p + rdlength;
        const parts: string[] = [];
        while (p < end && p < buf.length) {
          const l = buf[p++];
          parts.push(buf.subarray(p, p + l).toString('latin1'));
          p += l;
        }
        data = parts.join(' ');
        p = end;
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
  /** TTL on the queried-apex CNAME (live.rte.ie) — the mode-switch pointer. */
  apexTtl: number | null;
  /** TTL on the NS1-record CNAME (*.nsone.rte.ie) — governs the SHED / platform decision. */
  recordTtl: number | null;
  /** TTL on the final A record (the Cloudflare-LB/edge value). A-RECORD ONLY — null when the
   *  result carries no A section (we never report a CNAME's TTL as the edge TTL). */
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

// Well-known PUBLIC recursive resolvers a probe may be configured with. Answers via these reflect
// the public resolver, NOT the ISP's own — so they are flagged and excluded from the ISP headline.
const PUBLIC_RESOLVERS = new Set([
  '8.8.8.8', '8.8.4.4', // Google
  '1.1.1.1', '1.0.0.1', '1.1.1.2', '1.0.0.2', // Cloudflare
  '9.9.9.9', '9.9.9.10', '9.9.9.11', '149.112.112.112', // Quad9
  '208.67.222.222', '208.67.220.220', // OpenDNS
  '94.140.14.14', '94.140.15.15', // AdGuard
  '76.76.2.0', '76.76.10.0', // ControlD
]);
// Anycast front IPs above; below are the EGRESS ranges public resolvers query authoritatives FROM
// (what whoami.ds.akahelp.net reports as `ns`). A CPE can forward to a public resolver, so the real
// resolver revealed by whoami is a public EGRESS even when the probe's dst_addr looked private.
const PUBLIC_PREFIXES = [
  '45.90.28.', '45.90.30.', '149.112.', '2620:fe::',
  // Cloudflare (1.1.1.1) egress: 172.64.0.0/13, 162.158.0.0/15, 2400:cb00::/32, 2606:4700::/32.
  '172.64.', '172.65.', '172.66.', '172.67.', '172.68.', '172.69.', '172.70.', '172.71.',
  '162.158.', '162.159.', '2400:cb00', '2606:4700',
  // Google (8.8.8.8) egress + anycast, Quad9.
  '2001:4860:4860', '2001:4860:4801', '74.125.', '172.253.',
];
export function isPublicResolver(addr: string): boolean {
  if (!addr) return false;
  if (PUBLIC_RESOLVERS.has(addr)) return true;
  return PUBLIC_PREFIXES.some((p) => addr.startsWith(p));
}

/** Summarise a decoded chain into platform + the three distinct TTLs. Each hop is a separate RR
 *  cached independently by the resolver, so its TTL reflects that hop's own cache state — we must
 *  read each by its OWNER name, never by position, and never report a CNAME's TTL as the edge. */
export function summarizeChain(rrs: DnsRR[]): ChainSummary {
  const hops = rrs
    .filter((r) => r.type === 5 || r.type === 1)
    .map((r) => ({ name: r.name, type: (r.type === 5 ? 'CNAME' : 'A') as 'CNAME' | 'A', ttl: r.ttl, data: r.data }));
  const cnames = hops.filter((h) => h.type === 'CNAME');
  const aRecords = hops.filter((h) => h.type === 'A');
  const target = cnames.length ? cnames[cnames.length - 1].data : (aRecords[0]?.name ?? null);
  const platform = target ? platformOf(target) : aRecords.length ? platformOf(aRecords[0].data) : null;
  const ttls = hops.map((h) => h.ttl);
  // The NS1-record CNAME is the hop OWNED by the *.nsone.rte.ie name (its TTL governs the shed /
  // platform decision). The apex is the top CNAME (the queried name). Edge is the delivery A only.
  const recordHop = cnames.find((c) => /\.nsone\./i.test(c.name));
  return {
    platform,
    target,
    vips: aRecords.map((a) => a.data),
    apexTtl: cnames[0]?.ttl ?? null,
    recordTtl: recordHop?.ttl ?? null,
    edgeTtl: aRecords.length ? aRecords[0].ttl : null, // A-record ONLY — never a CNAME TTL
    minTtl: ttls.length ? Math.min(...ttls) : null,
    hops,
  };
}

// ---- Resolver identity (whoami) ----------------------------------------------------------------
// A whoami query (whoami.ds.akahelp.net TXT) returns TXT records revealing the ACTUAL upstream
// recursive resolver ("ns <ip>") and the EDNS Client Subnet it forwarded ("ecs <subnet>"). This
// pierces the home-router/CPE forwarder to show the ISP's real resolver + how precisely NS1 can
// steer it. Values may be absent (a resolver that sends no ECS → ecs null).
export interface WhoamiAnswer {
  /** The real recursive resolver's IP as seen by the authoritative. */
  ns: string | null;
  /** The EDNS Client Subnet the resolver forwarded (e.g. "51.171.0.0/24"), or null if none. */
  ecs: string | null;
  /** The ECS source-prefix length (24, 56, …), or null. Finer = more precise steering. */
  ecsPrefix: number | null;
}

export function parseWhoami(rrs: DnsRR[]): WhoamiAnswer {
  let ns: string | null = null;
  let ecs: string | null = null;
  for (const r of rrs) {
    if (r.type !== 16) continue; // TXT only
    const sp = r.data.indexOf(' ');
    const key = (sp === -1 ? r.data : r.data.slice(0, sp)).toLowerCase();
    const val = sp === -1 ? '' : r.data.slice(sp + 1).trim();
    if (key === 'ns' && !ns && val) ns = val;
    if (key === 'ecs' && !ecs && val) ecs = val;
  }
  let ecsNorm: string | null = null;
  let ecsPrefix: number | null = null;
  if (ecs) {
    // akahelp reports "<subnet>/<scope>/<source>" or "<subnet>/<prefix>"; keep subnet + first prefix.
    const m = ecs.match(/^([0-9a-f:.]+)\/(\d+)/i);
    if (m) { ecsNorm = `${m[1]}/${m[2]}`; ecsPrefix = Number(m[2]); }
    else ecsNorm = ecs;
  }
  return { ns, ecs: ecsNorm, ecsPrefix };
}

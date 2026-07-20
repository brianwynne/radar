// Pure parsers for the CloudVision `analytics` dataset wire shapes (verified live against
// CVaaS). These turn the nested, wrapped analytics JSON into flat, typed values for the
// adapter. Everything here is pure and total: an unexpected/absent shape yields null (a
// completeness signal), never a fabricated value. Analytics/CloudVision shapes never leave
// this module + the http-client — the rest of RADAR sees only the canonical model.

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Unwrap the `{ key, value }` envelope analytics uses for every field. */
export function unwrap(v: unknown): unknown {
  if (isObj(v) && 'value' in v && 'key' in v && Object.keys(v).length === 2) return (v as { value: unknown }).value;
  return v;
}

/** A scalar number from analytics' wrappers: plain, `{int:n}`, `{float:n}`, or nested `{value:{int}}`. */
export function num(v: unknown): number | null {
  let u = unwrap(v);
  if (isObj(u) && 'value' in u && !('int' in u) && !('float' in u)) u = u.value; // nested `{value:{int}}`
  if (typeof u === 'number' && Number.isFinite(u)) return u;
  if (isObj(u) && typeof u.int === 'number' && Number.isFinite(u.int)) return u.int;
  if (isObj(u) && typeof u.float === 'number' && Number.isFinite(u.float)) return u.float;
  return null;
}

/** The `avg` of an analytics rate-stats object `{avg:{float},max,min,stddev,weight}`; else a plain number. */
export function rateAvg(v: unknown): number | null {
  const u = unwrap(v);
  if (isObj(u) && 'avg' in u) return num(u.avg);
  return num(u);
}

/** A string from analytics wrappers. */
export function str(v: unknown): string | null {
  const u = unwrap(v);
  return typeof u === 'string' ? u : null;
}

/** BGP FSM name from `bgpState = { Name: "Established", Value: { int: 6 } }`. */
export function bgpStateName(v: unknown): string | null {
  const u = unwrap(v);
  if (isObj(u) && typeof u.Name === 'string') return u.Name;
  return typeof u === 'string' ? u : null;
}

export interface InterfaceRates {
  inBps: number | null;
  outBps: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
}

/** Parse a `interfaces/data/<intf>/rates` updates map (the 10-second rate node). Octet fields
 *  are octets/sec scalars → ×8 = bits/sec; `rateAvg` also tolerates the `{avg,…}` rate-stats
 *  shape of the aggregate windows. Errors/discards are their per-second rates. */
export function parseInterfaceRates(updates: Record<string, unknown>): InterfaceRates {
  const bps = (k: string): number | null => {
    const oct = rateAvg(updates[k]);
    return oct === null ? null : oct * 8;
  };
  return {
    inBps: bps('inOctets'),
    outBps: bps('outOctets'),
    inErrors: rateAvg(updates.inErrors),
    outErrors: rateAvg(updates.outErrors),
    inDiscards: rateAvg(updates.inDiscards),
    outDiscards: rateAvg(updates.outDiscards),
  };
}

/** Parse a `interfaces/data/<intf>/utilization` updates map → percent 0..100. */
export function parseUtilisation(updates: Record<string, unknown>): { inPercent: number | null; outPercent: number | null } {
  return { inPercent: num(updates['inOctets-utilization']), outPercent: num(updates['outOctets-utilization']) };
}

/** Derive configured speed (bps) from a rate + its pre-computed utilisation%: speed = bps /
 *  (util/100). Null when either is missing or util is ~0 (can't divide). */
export function speedFromUtilisation(bps: number | null, utilPercent: number | null): number | null {
  if (bps === null || utilPercent === null || !Number.isFinite(bps) || !Number.isFinite(utilPercent) || utilPercent <= 0.01) return null;
  return (bps / utilPercent) * 100;
}

/** Interface operational speed (bps) read straight from a device Sysdb interface-status record
 *  (the authoritative value, not a derivation). LAGs carry `speedMbps` (Mbps — the summed
 *  bandwidth of active members); physical ports carry a `speedEnum` like {Name:"speed100Gbps"}.
 *  Prefer speedMbps when it's a real value (>0), else parse the enum. Returns null when neither
 *  is usable — e.g. a down/optic-less port or a LAG with no active members reporting
 *  speedUnknown (the caller then falls back to deriving speed from utilisation). */
export function speedFromStatus(updates: Record<string, unknown>): number | null {
  const mbps = num(updates.speedMbps);
  if (mbps !== null && mbps > 0) return mbps * 1_000_000;
  const e = unwrap(updates.speedEnum);
  const name = isObj(e) && typeof e.Name === 'string' ? e.Name : typeof e === 'string' ? e : null;
  return speedFromEnumName(name);
}

const SPEED_ENUM = /^speed(\d+(?:p\d+)?)(Mbps|Gbps|Tbps)$/;
/** Parse an EOS speed enum name → bps: "speed100Gbps"→1e11, "speed2p5Gbps"→2.5e9 (the "p" is a
 *  decimal point), "speed1p6Tbps"→1.6e12. Returns null for "speedUnknown"/unrecognised names. */
export function speedFromEnumName(name: string | null): number | null {
  if (!name) return null;
  const m = SPEED_ENUM.exec(name);
  if (!m) return null;
  const value = parseFloat(m[1].replace('p', '.'));
  const unit = m[2] === 'Tbps' ? 1e12 : m[2] === 'Gbps' ? 1e9 : 1e6;
  return Number.isFinite(value) ? value * unit : null;
}

export interface BgpPeerFields {
  asn: number | null;
  state: string | null;
  localAddr: string | null;
  description: string | null;
  intfId: string | null;
  /** Provider parsed from the description (e.g. "Cogent" from "[Transit] Cogent 3-…"). */
  provider: string | null;
  /** Link-type hint from a description tag like "[Transit]"/"[PNI]"/"[INEX]". */
  linkTypeHint: 'TRANSIT' | 'PRIVATE_PEERING' | 'IX_PEERING' | null;
  /** Human connection type from the description tag: PNI / INEX / Transit / Peer / Route collector /
   *  iBGP (verbatim-ish), for display + grouping. Null when the description carries no tag. */
  connectionType: string | null;
  /** Epoch SECONDS of the last into/out-of-established transition (→ uptime when established). */
  establishedTime: number | null;
  /** Remote peer's BGP router-id. */
  routerId: string | null;
  adminShutdown: boolean | null;
  /** Active address families (short labels, e.g. ["IPv4","IPv6"]). */
  addressFamilies: string[];
}

/** Parse a `bgpPeerInfoStatusEntry/<peer>` leaf updates map. */
export function parseBgpPeer(updates: Record<string, unknown>): BgpPeerFields {
  const description = str(updates.bgpPeerDescription);
  const { provider, linkTypeHint, connectionType } = parseBgpDescription(description);
  return {
    asn: num(updates.bgpPeerAs),
    state: bgpStateName(updates.bgpState),
    localAddr: str(updates.bgpPeerLocalAddr),
    description,
    intfId: str(updates.intfId),
    provider,
    linkTypeHint,
    connectionType,
    establishedTime: num(updates.bgpPeerIntoOrOutOfEstablishedTime),
    routerId: str(updates.bgpPeerRouterId),
    adminShutdown: bool(updates.bgpPeerAdminShutDown),
    addressFamilies: parseAfiSafiActive(updates.bgpPeerAfiSafiActive),
  };
}

/** A boolean from analytics wrappers. */
export function bool(v: unknown): boolean | null {
  const u = unwrap(v);
  return typeof u === 'boolean' ? u : null;
}

const AFI_LABELS: Record<string, string> = {
  ipv4Unicast: 'IPv4', ipv6Unicast: 'IPv6', ipv4Multicast: 'IPv4-mcast', ipv6Multicast: 'IPv6-mcast',
  l2VpnEvpn: 'EVPN', ipv4Flowspec: 'IPv4-fs', ipv6Flowspec: 'IPv6-fs', vpnIpv4: 'VPN-IPv4', vpnIpv6: 'VPN-IPv6',
};
/** Active address families from `bgpPeerAfiSafiActive = {ipv4Unicast:true, ipv6Unicast:false, …}`. */
export function parseAfiSafiActive(v: unknown): string[] {
  const u = unwrap(v);
  if (!isObj(u)) return [];
  return Object.entries(u).filter(([, val]) => val === true).map(([k]) => AFI_LABELS[k] ?? k);
}

/** Extract provider + link-type from a peer description like "[Transit] Cogent 3-002188930".
 *  Only associates a provider where the description supports it — never fabricated. */
export function parseBgpDescription(description: string | null): { provider: string | null; linkTypeHint: BgpPeerFields['linkTypeHint']; connectionType: string | null } {
  if (!description) return { provider: null, linkTypeHint: null, connectionType: null };
  const tag = /^\s*\[([^\]]+)\]\s*/.exec(description);
  let linkTypeHint: BgpPeerFields['linkTypeHint'] = null;
  let connectionType: string | null = null;
  let rest = description;
  if (tag) {
    const t = tag[1].toLowerCase();
    // Human connection type (PNI is a private interconnect; INEX/IX is exchange peering).
    connectionType = /pni/.test(t) ? 'PNI'
      : /transit/.test(t) ? 'Transit'
      : /inex|\bix\b|exchange/.test(t) ? 'INEX'
      : /route\s*collector|^rc$/.test(t) ? 'Route collector'
      : /ibgp/.test(t) ? 'iBGP'
      : /peer/.test(t) ? 'Peer'
      : tag[1];
    linkTypeHint = /pni|peer/.test(t) ? 'PRIVATE_PEERING' : /inex|\bix\b|exchange/.test(t) ? 'IX_PEERING' : /transit/.test(t) ? 'TRANSIT' : null;
    rest = description.slice(tag[0].length);
  }
  // Provider = the text after the tag, minus a trailing ref code like "3-002188930" (keeps
  // multi-word names, e.g. "Liberty Global", "BT Ireland").
  const provider = rest.trim().replace(/\s+\d+-\S+$/, '').trim() || null;
  return { provider, linkTypeHint, connectionType };
}

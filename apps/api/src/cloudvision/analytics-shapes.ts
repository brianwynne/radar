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

export interface BgpPeerFields {
  asn: number | null;
  state: string | null;
  localAddr: string | null;
  description: string | null;
  intfId: string | null;
  /** Provider parsed from the description (e.g. "Cogent" from "[Transit] Cogent 3-…"). */
  provider: string | null;
  /** Link-type hint from a description tag like "[Transit]"/"[Peering]"/"[IX]". */
  linkTypeHint: 'TRANSIT' | 'PRIVATE_PEERING' | 'IX_PEERING' | null;
}

/** Parse a `bgpPeerInfoStatusEntry/<peer>` leaf updates map. */
export function parseBgpPeer(updates: Record<string, unknown>): BgpPeerFields {
  const description = str(updates.bgpPeerDescription);
  const { provider, linkTypeHint } = parseBgpDescription(description);
  return {
    asn: num(updates.bgpPeerAs),
    state: bgpStateName(updates.bgpState),
    localAddr: str(updates.bgpPeerLocalAddr),
    description,
    intfId: str(updates.intfId),
    provider,
    linkTypeHint,
  };
}

/** Extract provider + link-type from a peer description like "[Transit] Cogent 3-002188930".
 *  Only associates a provider where the description supports it — never fabricated. */
export function parseBgpDescription(description: string | null): { provider: string | null; linkTypeHint: BgpPeerFields['linkTypeHint'] } {
  if (!description) return { provider: null, linkTypeHint: null };
  const tag = /^\s*\[([^\]]+)\]\s*/.exec(description);
  let linkTypeHint: BgpPeerFields['linkTypeHint'] = null;
  let rest = description;
  if (tag) {
    const t = tag[1].toLowerCase();
    linkTypeHint = /transit/.test(t) ? 'TRANSIT' : /ix|inex|exchange/.test(t) ? 'IX_PEERING' : /peer/.test(t) ? 'PRIVATE_PEERING' : null;
    rest = description.slice(tag[0].length);
  }
  // Provider = the first token after the tag (e.g. "Cogent"), trimmed of trailing ref codes.
  const provider = rest.trim().split(/[\s,]+/)[0] || null;
  return { provider: provider && provider.length > 0 ? provider : null, linkTypeHint };
}

// Prefix (IP block) WHOIS via RIPEstat (stat.ripe.net), read-only and in-memory cached. bgp.tools
// itself offers a whois interface (whois.bgp.tools:43), but that is ASN/prefix mapping we already
// have; the RIR registration (netname / organisation / country / registry) is the classic whois
// data, so RADAR resolves it externally from RIPEstat — the same source used for ASN ownership.
// Results are cached (registration is stable) with a long TTL; failures cache briefly. Injectable
// fetch for tests.

export interface PrefixWhois {
  prefix: string;
  netname: string | null;
  description: string | null;
  organisation: string | null;
  country: string | null;
  /** Registering authority (ripe / arin / apnic / …). */
  registry: string | null;
}

export interface PrefixWhoisResolver {
  readonly source: string;
  lookup(prefix: string): Promise<PrefixWhois>;
}

interface Options {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  ttlMs?: number;
  negativeTtlMs?: number;
  timeoutMs?: number;
}

type Record_ = { key?: string; value?: string }[];
const firstValue = (rec: Record_, key: string): string | null => {
  const hit = rec.find((kv) => (kv.key ?? '').toLowerCase() === key);
  const v = hit?.value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

export function createRipestatWhoisResolver(opts: Options = {}): PrefixWhoisResolver {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? 'https://stat.ripe.net').replace(/\/$/, '');
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000; // registration is stable — cache a day
  const negativeTtlMs = opts.negativeTtlMs ?? 5 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cache = new Map<string, { whois: PrefixWhois; at: number }>();
  const empty = (prefix: string): PrefixWhois => ({ prefix, netname: null, description: null, organisation: null, country: null, registry: null });
  const fresh = (e: { whois: PrefixWhois; at: number }): boolean =>
    Date.now() - e.at < (e.whois.netname === null ? negativeTtlMs : ttlMs);

  return {
    source: 'ripestat',
    async lookup(prefix: string): Promise<PrefixWhois> {
      const cached = cache.get(prefix);
      if (cached && fresh(cached)) return cached.whois;
      let whois = empty(prefix);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(`${baseUrl}/data/whois/data.json?resource=${encodeURIComponent(prefix)}&sourceapp=radar`, { signal: ctrl.signal });
          if (res.ok) {
            const body = (await res.json()) as { data?: { records?: Record_[]; authorities?: unknown[] } };
            const records = body?.data?.records ?? [];
            // The registration record is the one carrying a netname (inetnum/inet6num object).
            const rec = records.find((r) => firstValue(r, 'netname') !== null) ?? records[0] ?? [];
            const registry = Array.isArray(body?.data?.authorities) && typeof body.data.authorities[0] === 'string' ? (body.data.authorities[0] as string) : null;
            whois = {
              prefix,
              netname: firstValue(rec, 'netname'),
              description: firstValue(rec, 'descr'),
              organisation: firstValue(rec, 'org') ?? firstValue(rec, 'organisation') ?? firstValue(rec, 'owner'),
              country: firstValue(rec, 'country'),
              registry,
            };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        whois = empty(prefix);
      }
      cache.set(prefix, { whois, at: Date.now() });
      return whois;
    },
  };
}

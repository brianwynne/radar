// ASN → network-owner resolution via RIPEstat (stat.ripe.net), read-only and in-memory cached.
// ASN ownership is not present in NS1 or any platform RADAR runs, so this is an external lookup.
// Results are cached (ASN ownership is stable) with a long TTL; failures cache briefly so a
// transient outage retries soon. Requests are concurrency-bounded so resolving a config's ~100
// ASNs does not stampede the API. Injectable fetch for tests.

export interface AsnResolver {
  readonly source: string;
  /** Resolve each ASN to its holder name (null when unknown/unresolved). Deduped internally. */
  resolve(asns: number[]): Promise<Map<number, string | null>>;
}

interface Options {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  ttlMs?: number;
  negativeTtlMs?: number;
  concurrency?: number;
  timeoutMs?: number;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createRipestatResolver(opts: Options = {}): AsnResolver {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? 'https://stat.ripe.net').replace(/\/$/, '');
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000; // ownership is stable — cache a day
  const negativeTtlMs = opts.negativeTtlMs ?? 5 * 60 * 1000; // retry failures soon
  const concurrency = opts.concurrency ?? 8;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cache = new Map<number, { holder: string | null; at: number }>();

  const fresh = (e: { holder: string | null; at: number }): boolean =>
    Date.now() - e.at < (e.holder === null ? negativeTtlMs : ttlMs);

  async function resolveOne(asn: number): Promise<string | null> {
    const cached = cache.get(asn);
    if (cached && fresh(cached)) return cached.holder;
    let holder: string | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/data/as-overview/data.json?resource=AS${asn}`, { signal: ctrl.signal });
        if (res.ok) {
          const body = (await res.json()) as { data?: { holder?: unknown } };
          const h = body?.data?.holder;
          holder = typeof h === 'string' && h.trim() ? h.trim() : null;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      holder = null;
    }
    cache.set(asn, { holder, at: Date.now() });
    return holder;
  }

  return {
    source: 'ripestat',
    async resolve(asns: number[]): Promise<Map<number, string | null>> {
      const unique = [...new Set(asns)].filter((n) => Number.isInteger(n) && n > 0);
      const holders = await pool(unique, concurrency, resolveOne);
      return new Map(unique.map((asn, i) => [asn, holders[i]]));
    },
  };
}

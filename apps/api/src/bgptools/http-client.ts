// Live bgp.tools read-client over the DOCUMENTED bulk export (table.jsonl). READ-ONLY. The table
// is the whole global routing table (~1M+ lines), so we STREAM it line by line and keep only the
// monitored prefixes — never buffering the full body. bgp.tools requires an identifying User-Agent
// (it blocks generic agents) and asks callers to cache / not fetch more than every 30 min; the
// poller owns the cadence and we send a conditional GET (If-None-Match) so an unchanged table
// returns 304 and reuses the last result.
//
// NOTE: the per-prefix WHOIS bulk interface (whois.bgp.tools:43) is a lighter alternative for a
// small watch list and can be added behind this same contract; table.jsonl is the documented HTTP
// path implemented here. The optional token is sent as a bearer header ONLY when configured — the
// exact auth scheme the account's key uses will be confirmed against bgp.tools' docs before live
// use (bgp.tools' public exports authenticate by User-Agent, not a token).
import type { BgpToolsPing, BgpToolsReadClient } from './client.js';
import type { MonitoredPrefix, ObservedOrigin, RawRoutingObservation } from './types.js';

export class BgpToolsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BgpToolsError';
  }
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

export interface HttpBgpToolsClientOptions {
  tableUrl: string;
  /** Identifying User-Agent, e.g. "RADAR bgp.tools - noc@rte.ie". Required. */
  userAgent: string;
  /** Optional API token (bearer). Never logged. */
  token?: string;
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

/** One parsed table row. bgp.tools emits capitalised keys: {"CIDR","ASN","Hits"}. */
function parseRow(line: string): { cidr: string; asn: number; hits: number } | null {
  const t = line.trim();
  if (!t) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null; // a malformed line must not abort the whole stream
  }
  const cidr = (o.CIDR ?? o.cidr) as unknown;
  const asn = Number(o.ASN ?? o.asn);
  const hits = Number(o.Hits ?? o.hits ?? 0);
  if (typeof cidr !== 'string' || !Number.isFinite(asn)) return null;
  return { cidr, asn, hits: Number.isFinite(hits) ? hits : 0 };
}

/** Yield the body one line at a time, tolerating chunk boundaries mid-line. */
async function* iterLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) yield buf;
}

export class HttpBgpToolsClient implements BgpToolsReadClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Conditional-GET cache: the last ETag and the origins we extracted for it. */
  private lastEtag: string | null = null;
  private lastOrigins: Map<string, ObservedOrigin[]> = new Map();

  constructor(private readonly opts: HttpBgpToolsClientOptions) {
    if (!opts.userAgent || !/\S+@\S+/.test(opts.userAgent)) {
      throw new BgpToolsError('BGPTOOLS_USER_AGENT', 'An identifying User-Agent with a contact email is required (bgp.tools blocks generic agents).');
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'User-Agent': this.opts.userAgent,
      Accept: 'application/x-ndjson, application/jsonl, text/plain, */*',
      ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
      ...extra,
    };
  }

  async fetchObservations(prefixes: MonitoredPrefix[]): Promise<RawRoutingObservation[]> {
    const wanted = new Map(prefixes.map((p) => [p.prefix, p]));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let originsByPrefix: Map<string, ObservedOrigin[]>;
    try {
      const res = await this.fetchImpl(this.opts.tableUrl, {
        headers: this.headers(this.lastEtag ? { 'If-None-Match': this.lastEtag } : {}),
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.status === 304) {
        originsByPrefix = this.lastOrigins; // table unchanged since last poll → reuse
      } else if (!res.ok) {
        throw new BgpToolsError(res.status === 401 || res.status === 403 ? 'BGPTOOLS_AUTH' : 'BGPTOOLS_HTTP', `bgp.tools table fetch failed (HTTP ${res.status}).`);
      } else if (!res.body) {
        throw new BgpToolsError('BGPTOOLS_EMPTY', 'bgp.tools table response had no body.');
      } else {
        originsByPrefix = new Map();
        let malformed = 0;
        for await (const line of iterLines(res.body)) {
          const row = parseRow(line);
          if (row === null) { if (line.trim()) malformed += 1; continue; }
          if (!wanted.has(row.cidr)) continue; // stream-filter to the watch list only
          const list = originsByPrefix.get(row.cidr) ?? [];
          list.push({ asn: row.asn, hits: row.hits });
          originsByPrefix.set(row.cidr, list);
        }
        if (malformed > 0) this.opts.logger?.warn({ malformed }, 'bgptools: skipped malformed table lines');
        this.lastEtag = res.headers.get('etag');
        this.lastOrigins = originsByPrefix;
      }
    } finally {
      clearTimeout(timer);
    }

    const at = new Date(this.now());
    // A monitored prefix absent from the table is withdrawn (empty origins) — never dropped.
    return prefixes.map((p) => ({
      prefix: p.prefix,
      addressFamily: p.addressFamily,
      origins: originsByPrefix.get(p.prefix) ?? [],
      observedAt: at,
    }));
  }

  async ping(): Promise<BgpToolsPing> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(this.opts.tableUrl, { method: 'HEAD', headers: this.headers(), signal: controller.signal, redirect: 'follow' });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `authorisation rejected (HTTP ${res.status})` };
      if (!res.ok && res.status !== 304) return { ok: false, detail: `unexpected status HTTP ${res.status}` };
      const host = (() => { try { return new URL(this.opts.tableUrl).host; } catch { return 'bgp.tools'; } })();
      return { ok: true, detail: `reached ${host} (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }
}

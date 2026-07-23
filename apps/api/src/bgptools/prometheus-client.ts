// bgp.tools per-account Prometheus monitoring client. READ-ONLY. Scrapes the account's metrics
// endpoint (prometheus.bgp.tools/prom/<uuid>) — the UUID in the URL IS the credential, so the URL
// is secret and never logged. Parses the Prometheus text-exposition format (NOT the query API) and
// projects the bgp.tools metric families into a vendor-neutral snapshot: per-prefix visibility +
// upstreams, and per-ASN topology. The set of prefixes/ASNs present also tells us what the account
// is actually monitoring.
import type { BgpToolsPing } from './client.js';
import { BgpToolsError } from './http-client.js';
import type { AsnMetrics, BgpToolsMetricsSnapshot, PrefixMetrics } from './types.js';

interface Logger { warn(obj: unknown, msg?: string): void }

export interface PrometheusClientOptions {
  /** Full metrics URL including the account UUID. SECRET — never logged. */
  metricsUrl: string;
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+]?[\d.eE+]+|NaN|[-+]?Inf)\s*(?:#.*)?$/;

/** Parse Prometheus text exposition into samples, ignoring # HELP/# TYPE/# comment lines. */
export function parseExposition(text: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = SAMPLE_RE.exec(line);
    if (!m) continue;
    const [, name, labelBlock, rawValue] = m;
    const value = rawValue === 'NaN' ? NaN : rawValue.endsWith('Inf') ? (rawValue[0] === '-' ? -Infinity : Infinity) : Number(rawValue);
    out.push({ name, labels: labelBlock ? parseLabels(labelBlock) : {}, value });
  }
  return out;
}

function parseLabels(block: string): Record<string, string> {
  const labels: Record<string, string> = {};
  // block is like {asn="41073",prefix="89.207.56.0/21"} — values are double-quoted, may contain commas.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  }
  return labels;
}

const numOrNull = (v: number | undefined): number | null => (v === undefined || !Number.isFinite(v) ? null : v);

/** Project the raw samples into the bgp.tools metrics snapshot. Pure. */
export function projectMetrics(samples: MetricSample[], observedAt: Date): BgpToolsMetricsSnapshot {
  const prefixMap = new Map<string, PrefixMetrics>();
  const asnMap = new Map<number, AsnMetrics>();
  const prefixKey = (asn: string, prefix: string) => `${asn}|${prefix}`;
  const getPrefix = (asn: string, prefix: string): PrefixMetrics => {
    const k = prefixKey(asn, prefix);
    let p = prefixMap.get(k);
    if (!p) { p = { prefix, originAsn: Number(asn), visiblePaths: null, upstreamCount: null, upstreams: [] }; prefixMap.set(k, p); }
    return p;
  };
  const getAsn = (asn: string): AsnMetrics => {
    const n = Number(asn);
    let a = asnMap.get(n);
    if (!a) { a = { asn: n, prefixesTotal: null, prefixesLowVis: null, cone: null, upstreams: null, downstreams: null, peers: null }; asnMap.set(n, a); }
    return a;
  };

  for (const s of samples) {
    const { asn, prefix, upstream } = s.labels;
    switch (s.name) {
      case 'bgptools_asn_prefix_visible':
        if (asn && prefix) getPrefix(asn, prefix).visiblePaths = numOrNull(s.value);
        break;
      case 'bgptools_prefix_upstreams':
        if (asn && prefix) getPrefix(asn, prefix).upstreamCount = numOrNull(s.value);
        break;
      case 'bgptools_prefix_upstream_seen':
        if (asn && prefix && upstream && s.value === 1) {
          const p = getPrefix(asn, prefix);
          const u = Number(upstream);
          if (Number.isFinite(u) && !p.upstreams.includes(u)) p.upstreams.push(u);
        }
        break;
      case 'bgptools_asn_prefixes_total': if (asn) getAsn(asn).prefixesTotal = numOrNull(s.value); break;
      case 'bgptools_asn_prefixes_total_with_lowvis': if (asn) getAsn(asn).prefixesLowVis = numOrNull(s.value); break;
      case 'bgptools_asn_cone': if (asn) getAsn(asn).cone = numOrNull(s.value); break;
      case 'bgptools_asn_upstreams': if (asn) getAsn(asn).upstreams = numOrNull(s.value); break;
      case 'bgptools_asn_downstreams': if (asn) getAsn(asn).downstreams = numOrNull(s.value); break;
      case 'bgptools_asn_peers': if (asn) getAsn(asn).peers = numOrNull(s.value); break;
      default: break; // unknown families are ignored (never fabricated)
    }
  }
  for (const p of prefixMap.values()) p.upstreams.sort((a, b) => a - b);
  return { observedAt, prefixes: [...prefixMap.values()], asns: [...asnMap.values()] };
}

export class PrometheusBgpToolsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: PrometheusClientOptions) {
    if (!opts.userAgent || !/\S+@\S+/.test(opts.userAgent)) {
      throw new BgpToolsError('BGPTOOLS_USER_AGENT', 'An identifying User-Agent with a contact email is required (bgp.tools blocks generic agents).');
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async fetchMetrics(): Promise<BgpToolsMetricsSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(this.opts.metricsUrl, {
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'text/plain, */*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.status === 401 || res.status === 403) throw new BgpToolsError('BGPTOOLS_AUTH', `bgp.tools metrics authorisation rejected (HTTP ${res.status}).`);
      if (!res.ok) throw new BgpToolsError('BGPTOOLS_HTTP', `bgp.tools metrics fetch failed (HTTP ${res.status}).`);
      const text = await res.text();
      return projectMetrics(parseExposition(text), new Date(this.now()));
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<BgpToolsPing> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(this.opts.metricsUrl, { headers: { 'User-Agent': this.opts.userAgent }, signal: controller.signal, redirect: 'follow' });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `authorisation rejected (HTTP ${res.status})` };
      if (!res.ok) return { ok: false, detail: `unexpected status HTTP ${res.status}` };
      const text = await res.text();
      const snap = projectMetrics(parseExposition(text), new Date(this.now()));
      return { ok: true, detail: `monitoring ${snap.prefixes.length} prefix(es) across ${snap.asns.length} ASN(s)` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }
}

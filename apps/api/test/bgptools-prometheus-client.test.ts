// bgp.tools Prometheus monitoring client: exposition parsing + projection into the metrics
// snapshot (visibility, upstreams, ASN topology), using the real metric families.
import { describe, it, expect, vi } from 'vitest';
import { parseExposition, projectMetrics, PrometheusBgpToolsClient } from '../src/bgptools/prometheus-client.js';

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const UA = 'RADAR bgp.tools - noc@rte.ie';
const URL = 'https://prometheus.bgp.tools/prom/test-uuid';

const BODY = [
  '# HELP bgptools_asn_prefix_visible The amount of paths bgp.tools can see for each prefix',
  '# TYPE bgptools_asn_prefix_visible gauge',
  'bgptools_asn_prefix_visible{asn="41073",prefix="89.207.56.0/21"} 2675',
  'bgptools_asn_prefix_visible{asn="41073",prefix="185.54.104.0/22"} 2600',
  '# TYPE bgptools_prefix_upstreams gauge',
  'bgptools_prefix_upstreams{asn="41073",prefix="185.54.104.0/22"} 3',
  'bgptools_prefix_upstream_seen{asn="41073",prefix="185.54.104.0/22",upstream="174"} 1',
  'bgptools_prefix_upstream_seen{asn="41073",prefix="185.54.104.0/22",upstream="3356"} 1',
  'bgptools_prefix_upstream_seen{asn="41073",prefix="185.54.104.0/22",upstream="6939"} 0', // not seen → excluded
  'bgptools_asn_cone{asn="41073"} 0',
  'bgptools_asn_upstreams{asn="41073"} 3',
  'bgptools_asn_peers{asn="41073"} 12',
  'bgptools_asn_prefixes_total{asn="41073"} 5',
  'bgptools_asn_prefixes_total_with_lowvis{asn="41073"} 7',
  '', // blank
].join('\n');

describe('parseExposition', () => {
  it('parses samples and labels, ignoring HELP/TYPE comments', () => {
    const samples = parseExposition(BODY);
    const vis = samples.find((s) => s.name === 'bgptools_asn_prefix_visible' && s.labels.prefix === '89.207.56.0/21')!;
    expect(vis.labels).toEqual({ asn: '41073', prefix: '89.207.56.0/21' });
    expect(vis.value).toBe(2675);
    expect(samples.every((s) => !s.name.startsWith('#'))).toBe(true);
  });
});

describe('projectMetrics', () => {
  const snap = projectMetrics(parseExposition(BODY), new Date(NOW));

  it('builds per-prefix visibility + upstreams (seen==1 only)', () => {
    const p = snap.prefixes.find((x) => x.prefix === '185.54.104.0/22')!;
    expect(p.originAsn).toBe(41073);
    expect(p.visiblePaths).toBe(2600);
    expect(p.upstreamCount).toBe(3);
    expect(p.upstreams).toEqual([174, 3356]); // sorted; 6939 excluded (seen=0)
    const q = snap.prefixes.find((x) => x.prefix === '89.207.56.0/21')!;
    expect(q.visiblePaths).toBe(2675);
    expect(q.upstreams).toEqual([]);
  });

  it('builds per-ASN topology', () => {
    const a = snap.asns.find((x) => x.asn === 41073)!;
    expect(a).toMatchObject({ cone: 0, upstreams: 3, peers: 12, prefixesTotal: 5, prefixesLowVis: 7 });
  });
});

describe('PrometheusBgpToolsClient', () => {
  it('requires an identifying User-Agent', () => {
    expect(() => new PrometheusBgpToolsClient({ metricsUrl: URL, userAgent: 'radar', timeoutMs: 100 })).toThrow(/User-Agent/);
  });

  it('fetches and projects the metrics', async () => {
    const fetchImpl = vi.fn(async () => new Response(BODY, { status: 200 })) as unknown as typeof fetch;
    const c = new PrometheusBgpToolsClient({ metricsUrl: URL, userAgent: UA, timeoutMs: 1000, fetchImpl, now: () => NOW });
    const snap = await c.fetchMetrics();
    expect(snap.prefixes).toHaveLength(2);
    expect(snap.asns).toHaveLength(1);
    expect(snap.observedAt.getTime()).toBe(NOW);
  });

  it('ping summarises coverage without leaking the URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(BODY, { status: 200 })) as unknown as typeof fetch;
    const c = new PrometheusBgpToolsClient({ metricsUrl: URL, userAgent: UA, timeoutMs: 1000, fetchImpl, now: () => NOW });
    const p = await c.ping();
    expect(p.ok).toBe(true);
    expect(p.detail).toMatch(/2 prefix/);
    expect(JSON.stringify(p)).not.toContain('test-uuid');
  });

  it('maps 403 to an auth error', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    const c = new PrometheusBgpToolsClient({ metricsUrl: URL, userAgent: UA, timeoutMs: 1000, fetchImpl });
    await expect(c.fetchMetrics()).rejects.toMatchObject({ code: 'BGPTOOLS_AUTH' });
  });
});

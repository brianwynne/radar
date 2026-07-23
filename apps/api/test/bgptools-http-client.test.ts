// bgp.tools HTTP client: streams table.jsonl, filters to the watch list, handles MOAS, withdrawn
// prefixes, conditional-GET (304) reuse, auth failure, and the identifying-User-Agent guard.
import { describe, it, expect, vi } from 'vitest';
import { HttpBgpToolsClient, BgpToolsError } from '../src/bgptools/http-client.js';
import type { MonitoredPrefix } from '../src/bgptools/types.js';

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const UA = 'RADAR bgp.tools - noc@rte.ie';

const MONITORED: MonitoredPrefix[] = [
  { prefix: '203.0.113.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110 },
  { prefix: '2001:db8::/32', addressFamily: 'ipv6', expectedOriginAsn: 2110 },
  { prefix: '198.51.100.0/24', addressFamily: 'ipv4', expectedOriginAsn: 2110 }, // absent from the table
];

const TABLE = [
  '{"CIDR":"8.8.8.0/24","ASN":15169,"Hits":100}', // not monitored → filtered out
  '{"CIDR":"203.0.113.0/24","ASN":2110,"Hits":88}',
  '{"CIDR":"203.0.113.0/24","ASN":64500,"Hits":20}', // MOAS
  'this is not json', // malformed → skipped, must not abort the stream
  '{"CIDR":"2001:db8::/32","ASN":2110,"Hits":95}',
  '', // blank line
].join('\n');

function tableResponse(): Response {
  return new Response(TABLE, { status: 200, headers: { etag: '"v1"', 'content-type': 'application/jsonl' } });
}

describe('HttpBgpToolsClient', () => {
  it('requires an identifying User-Agent with a contact', () => {
    expect(() => new HttpBgpToolsClient({ tableUrl: 'https://bgp.tools/table.jsonl', userAgent: 'radar', timeoutMs: 100 })).toThrow(/User-Agent/);
  });

  it('streams the table, filters to the watch list, handles MOAS and withdrawn', async () => {
    const fetchImpl = vi.fn(async () => tableResponse()) as unknown as typeof fetch;
    const c = new HttpBgpToolsClient({ tableUrl: 'https://bgp.tools/table.jsonl', userAgent: UA, timeoutMs: 1000, fetchImpl, now: () => NOW });
    const obs = await c.fetchObservations(MONITORED);

    expect(obs).toHaveLength(3);
    const v4 = obs.find((o) => o.prefix === '203.0.113.0/24')!;
    expect(v4.origins).toEqual([{ asn: 2110, hits: 88 }, { asn: 64500, hits: 20 }]); // MOAS, in order
    expect(obs.find((o) => o.prefix === '2001:db8::/32')!.origins).toEqual([{ asn: 2110, hits: 95 }]);
    expect(obs.find((o) => o.prefix === '198.51.100.0/24')!.origins).toEqual([]); // absent → withdrawn
    expect(obs.every((o) => o.observedAt.getTime() === NOW)).toBe(true);
    // Non-monitored prefix never appears.
    expect(obs.some((o) => o.prefix === '8.8.8.0/24')).toBe(false);
  });

  it('sends the identifying User-Agent on the request', async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return tableResponse();
    }) as unknown as typeof fetch;
    const c = new HttpBgpToolsClient({ tableUrl: 'https://bgp.tools/table.jsonl', userAgent: UA, timeoutMs: 1000, fetchImpl, now: () => NOW });
    await c.fetchObservations(MONITORED);
    expect(seen['User-Agent']).toBe(UA);
  });

  it('uses a conditional GET and reuses the last result on 304', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? tableResponse() : new Response(null, { status: 304 });
    }) as unknown as typeof fetch;
    const c = new HttpBgpToolsClient({ tableUrl: 'https://bgp.tools/table.jsonl', userAgent: UA, timeoutMs: 1000, fetchImpl, now: () => NOW });

    const first = await c.fetchObservations(MONITORED);
    const second = await c.fetchObservations(MONITORED);
    // Second request carried the ETag; the client reused the parsed origins.
    expect((calls[1].headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
    expect(second.find((o) => o.prefix === '203.0.113.0/24')!.origins).toEqual(first.find((o) => o.prefix === '203.0.113.0/24')!.origins);
  });

  it('maps 403 to an auth error', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const c = new HttpBgpToolsClient({ tableUrl: 'https://bgp.tools/table.jsonl', userAgent: UA, timeoutMs: 1000, fetchImpl });
    await expect(c.fetchObservations(MONITORED)).rejects.toMatchObject({ code: 'BGPTOOLS_AUTH' });
    await expect(c.fetchObservations(MONITORED)).rejects.toBeInstanceOf(BgpToolsError);
  });

  it('ping reports reachability without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const c = new HttpBgpToolsClient({ tableUrl: 'https://bgp.tools/table.jsonl', userAgent: UA, token: 'secret', timeoutMs: 1000, fetchImpl });
    const p = await c.ping();
    expect(p.ok).toBe(true);
    expect(p.detail).toContain('bgp.tools');
    expect(JSON.stringify(p)).not.toContain('secret');
  });
});

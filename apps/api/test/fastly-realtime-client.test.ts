// Fastly real-time client: exercised with an injected fetch — no real rt.fastly.com is contacted.
// Verifies the long-poll cursor path, the wire→canonical mapping (per-second buckets, bandwidth =
// body+header), timestamp/aggregate-delay handling, auth-error mapping, and that the token never
// leaks into the URL.
import { describe, it, expect } from 'vitest';
import { HttpFastlyRealtimeClient, parseBatch } from '../src/fastly/realtime-client.js';
import { FastlyError } from '../src/fastly/errors.js';

const TOKEN = 'fastly-super-secret-token';
const BASE = 'https://rt.example';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RESPONSE = {
  Timestamp: 1_465_921_328,
  AggregateDelay: 5,
  Data: [
    // deliberately out of order — the client must sort ascending by `recorded`
    { recorded: 1_465_921_327, aggregated: { requests: 20, hits: 15, miss: 5, errors: 1, body_size: 1_800, header_size: 200, status_2xx: 18, status_3xx: 0, status_4xx: 1, status_5xx: 1, status_200: 15, status_206: 3, status_404: 1, status_503: 1 }, datacenter: {} },
    { recorded: 1_465_921_326, aggregated: { requests: 10, hits: 7, miss: 3, errors: 0, body_size: 900, header_size: 100, status_2xx: 9, status_3xx: 0, status_4xx: 1, status_5xx: 0, status_200: 9, status_404: 1 }, datacenter: {} },
  ],
};

function capturingFetch(respond: (url: string) => Response): { fn: typeof fetch; urls: string[]; keys: (string | null)[] } {
  const urls: string[] = [];
  const keys: (string | null)[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    keys.push(new Headers(init?.headers).get('fastly-key'));
    return respond(String(input));
  }) as typeof fetch;
  return { fn, urls, keys };
}

function client(fetchImpl: typeof fetch) {
  return new HttpFastlyRealtimeClient({ realtimeApiBase: BASE, token: TOKEN, requestTimeoutMs: 2000, fetchImpl });
}

describe('HttpFastlyRealtimeClient', () => {
  it('long-polls /v1/channel/{id}/ts/{cursor} and maps per-second buckets, sorted ascending', async () => {
    const { fn, urls, keys } = capturingFetch(() => json(RESPONSE));
    const batch = await client(fn).pollChannel('svc-live', 1_465_921_320);

    expect(urls[0]).toBe(`${BASE}/v1/channel/svc-live/ts/1465921320`);
    expect(keys[0]).toBe(TOKEN);
    expect(urls[0]).not.toContain(TOKEN); // token rides in the header, never the URL

    expect(batch.nextTimestamp).toBe(1_465_921_328);
    expect(batch.aggregateDelaySeconds).toBe(5);
    expect(batch.samples.map((s) => s.second)).toEqual([1_465_921_326, 1_465_921_327]); // sorted

    const first = batch.samples[0];
    expect(first.requests).toBe(10);
    expect(first.hits).toBe(7);
    expect(first.miss).toBe(3);
    expect(first.bandwidthBytes).toBe(1_000); // 900 body + 100 header
    expect(first.status4xx).toBe(1);
    expect(first.at).toBe(new Date(1_465_921_326 * 1000).toISOString());
    // Individual status codes captured for drill-down; class aggregates (status_2xx) excluded.
    expect(first.statusCodes).toEqual({ '200': 9, '404': 1 });
    expect(batch.samples[1].statusCodes).toEqual({ '200': 15, '206': 3, '404': 1, '503': 1 });
  });

  it('starts from cursor 0 and keeps the cursor when the response omits a Timestamp', async () => {
    const { fn, urls } = capturingFetch(() => json({ Data: [] }));
    const batch = await client(fn).pollChannel('svc-live', 0);
    expect(urls[0]).toBe(`${BASE}/v1/channel/svc-live/ts/0`);
    expect(batch.samples).toEqual([]);
    expect(batch.nextTimestamp).toBe(0); // falls back to the requested cursor
  });

  it('maps 401 to a non-transient FASTLY_AUTH error and never leaks the token', async () => {
    const { fn } = capturingFetch(() => new Response('', { status: 401 }));
    await expect(client(fn).pollChannel('svc-live', 0)).rejects.toMatchObject({ code: 'FASTLY_AUTH', transient: false });
    try {
      await client(fn).pollChannel('svc-live', 0);
    } catch (err) {
      expect(JSON.stringify(err instanceof FastlyError ? { m: err.message, c: err.code } : err)).not.toContain(TOKEN);
    }
  });

  it('rejects a non-JSON body as FASTLY_INVALID_RESPONSE', async () => {
    const { fn } = capturingFetch(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client(fn).pollChannel('svc-live', 0)).rejects.toMatchObject({ code: 'FASTLY_INVALID_RESPONSE' });
  });

  it('parseBatch: falls back to resp_*_bytes then bandwidth for byte counts, drops second<=0', () => {
    const b = parseBatch({
      Timestamp: 100,
      Data: [
        { recorded: 50, aggregated: { requests: 1, resp_body_bytes: 400, resp_header_bytes: 100 } },
        { recorded: 51, aggregated: { requests: 2, bandwidth: 777 } },
        { recorded: 0, aggregated: { requests: 9 } }, // invalid second → dropped
      ],
    }, 0);
    expect(b.samples.map((s) => s.second)).toEqual([50, 51]);
    expect(b.samples[0].bandwidthBytes).toBe(500); // resp_body + resp_header
    expect(b.samples[1].bandwidthBytes).toBe(777); // bandwidth fallback
  });
});

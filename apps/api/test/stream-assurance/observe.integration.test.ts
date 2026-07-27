// End-to-end reproduction of the reference incident through REAL HTTP fetches: two "CDNs" backed by
// one mock origin that returns a DIFFERENT object depending on the forwarded Host header. Fastly
// forwards the origin host (live.rte.host) and gets the current KID from an edge HIT; Akamai forwards
// the public host (live.rte.ie), so the origin serves an OLD variant with edge+parent MISS and a
// months-old Last-Modified. RADAR must classify this as an origin/Host-header problem, not a stale
// CDN cache.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { observeAndClassify } from '../../src/stream-assurance/observe.js';
import { buildInit } from './init-fixture.js';

const CURRENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OLD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const host = req.headers.host;
    if (host === 'live.rte.host') {
      // Correct origin selection → current object, served from an edge cache HIT.
      res.writeHead(200, { 'content-type': 'video/mp4', 'last-modified': 'Sun, 26 Jul 2026 12:00:00 GMT', 'x-cache': 'HIT', 'x-served-by': 'cache-lhr-1' });
      res.end(buildInit(CURRENT));
    } else {
      // Wrong origin selection (public host) → origin serves an OLD variant; edge + parent both MISS.
      res.writeHead(200, { 'content-type': 'video/mp4', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT', 'x-cache': 'TCP_MISS from edge', 'x-cache-remote': 'TCP_MISS from parent' });
      res.end(buildInit(OLD));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const endpoint = (over: Record<string, unknown>) => ({
  publicUrl: 'http://live.rte.ie/live/a/channel/init.mp4', connectHost: '127.0.0.1', connectPort: port,
  managedInternal: true, originHost: 'live.rte.host', ...over,
});

describe('Stream Assurance — end-to-end incident reproduction', () => {
  it('probe → parse → classify yields ORIGIN_VARIANT_MISMATCH for the Host-mismatched CDN', async () => {
    const nowMs = Date.parse('2026-07-27T00:00:00Z');
    const { results, findings } = await observeAndClassify(
      [
        endpoint({ endpointId: 'fastly', provider: 'fastly', role: 'reference', hostHeader: 'live.rte.host' }),
        endpoint({ endpointId: 'akamai', provider: 'akamai', role: 'candidate', hostHeader: 'live.rte.ie' }),
      ],
      { allowManagedInternal: true },
      { nowMs },
    );

    const fastly = results.find((r) => r.observation.endpointId === 'fastly')!;
    const akamai = results.find((r) => r.observation.endpointId === 'akamai')!;
    // Full KIDs were extracted from the real fetched init segments — no fixed byte offsets.
    expect(fastly.observation.kid).toBe(CURRENT);
    expect(akamai.observation.kid).toBe(OLD);
    expect(akamai.observation.cdn.fetchedFromOrigin).toBe(true); // edge + parent both MISS

    const f = findings.find((x) => x.endpointId === 'akamai')!;
    expect(f).toBeDefined();
    expect(f.classification).toBe('ORIGIN_VARIANT_MISMATCH');
    expect(f.ruleId).toBe('SA-CDN-001');
    expect(f.likelyLayer).toBe('config'); // forwarded-Host mismatch, not a stale cache
    expect(f.explanation).toMatch(/live\.rte\.ie/);
    expect(f.explanation).toMatch(/origin, not a stale CDN cache/);
    expect(f.classification).not.toBe('CDN_EDGE_STALE');
  });

  it('SSRF blocks a loopback target that is not an approved managed-internal endpoint', async () => {
    const { results } = await observeAndClassify(
      [endpoint({ endpointId: 'x', provider: 'akamai', role: 'candidate', hostHeader: 'live.rte.ie', managedInternal: false })],
      { allowManagedInternal: true },
    );
    expect(results[0].observation.reachable).toBe(false);
    expect(results[0].error).toMatch(/SSRF|blocked/i);
  });
});

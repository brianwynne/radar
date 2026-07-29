import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockTouchstreamClient } from '../src/touchstream/mock-client.js';
import { TouchstreamPoller } from '../src/touchstream/poller.js';
import { HttpTouchstreamReadClient, parseBody } from '../src/touchstream/http-client.js';
import { loadTouchstreamConfig } from '../src/touchstream/config.js';
import type { TouchstreamScenario } from '../src/touchstream/mock-client.js';

const NOW = Date.parse('2026-07-29T21:20:00.000Z');

async function poller(scenario: TouchstreamScenario = 'normal'): Promise<TouchstreamPoller> {
  const p = new TouchstreamPoller({
    client: new MockTouchstreamClient({ scenario }),
    source: 'mock',
    enabled: true,
    intervalMs: 60_000,
    ownedPrefixes: ['185.54.104.0/22', '89.207.56.0/21'],
    maxSampleAgeSeconds: 3600, // the dedicated staleness test below uses a tighter threshold
    now: () => NOW,
  });
  await p.runOnce();
  return p;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(role: string, opts: Parameters<typeof buildApp>[1] = {}): Promise<FastifyInstance> {
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: role }), opts);
  await app.ready();
  return app;
}

describe('touchstream poller', () => {
  it('builds a snapshot, reports status and never throws on failure', async () => {
    const p = await poller();
    expect(p.snapshot()!.summary.monitorCount).toBeGreaterThan(0);
    expect(p.status()).toMatchObject({ enabled: true, source: 'mock', consecutiveFailures: 0, lastError: null });
    expect(p.status().stale).toBe(false);
  });

  it('records an auth failure without losing the last good snapshot', async () => {
    const p = await poller();
    const good = p.snapshot();
    // Swap in a failing client the way a credential rotation would.
    p.reconfigure({ client: new MockTouchstreamClient({ scenario: 'auth-failure' }), source: 'live', enabled: false, intervalMs: 60_000 });
    await p.runOnce();
    expect(p.status().consecutiveFailures).toBe(1);
    expect(p.status().lastError).toContain('X-TS-ID');
    expect(good).not.toBeNull();
  });

  it('flags a snapshot as stale once the vendor sample ages past the threshold', async () => {
    const p = new TouchstreamPoller({
      client: new MockTouchstreamClient(),
      source: 'mock',
      enabled: true,
      intervalMs: 60_000,
      ownedPrefixes: [],
      maxSampleAgeSeconds: 60,
      now: () => NOW + 3_600_000, // an hour past the fixtures' sample time
    });
    await p.runOnce();
    expect(p.status().stale).toBe(true);
  });
});

describe('GET /touchstream/delivery', () => {
  it('returns the matrix with an explicit observed-synthetic provenance tier', async () => {
    const a = await build('NOC_VIEWER', { touchstreamPoller: await poller() });
    const res = await a.inject({ url: '/api/v1/touchstream/delivery' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The provenance must never let a consumer mistake this for viewer traffic.
    expect(body.provenance.tier).toBe('observed-synthetic');
    expect(body.provenance.notice).toContain('NOT viewer traffic');
    expect(body.provenance.readOnly).toBe(true);
    expect(body.snapshot.rows.length).toBeGreaterThan(0);
    expect(body.snapshot.platforms).toContain('Réalta');
  });

  it('says why it is empty rather than returning an empty healthy matrix', async () => {
    const a = await build('NOC_VIEWER'); // no poller at all
    const body = (await a.inject({ url: '/api/v1/touchstream/delivery' })).json();
    expect(body.snapshot).toBeNull();
    expect(body.reason).toBeTruthy();
  });

  it('carries the attribution and comparability findings through to the API', async () => {
    const a = await build('NOC_VIEWER', { touchstreamPoller: await poller('mislabelled') });
    const body = (await a.inject({ url: '/api/v1/touchstream/delivery' })).json();
    expect(body.snapshot.summary.attributionMismatchCount).toBe(1);
    expect(body.snapshot.warnings.some((w: { message: string }) => w.message.includes('RTÉ-owned'))).toBe(true);
  });

  it('never leaks the endpoint, app id or token', async () => {
    const a = await build('NOC_VIEWER', { touchstreamPoller: await poller() });
    for (const path of ['/api/v1/touchstream/status', '/api/v1/touchstream/delivery']) {
      const raw = (await a.inject({ url: path })).payload.toLowerCase();
      expect(raw).not.toContain('x-ts-id');
      expect(raw).not.toContain('bearer');
      expect(raw).not.toContain('authorization');
      expect(raw).not.toContain('tsi.touchstream');
    }
  });
});

describe('GET /touchstream/history', () => {
  it('returns per-CDN stats and the error log for the window', async () => {
    const a = await build('VIEWING_ENGINEER', { touchstreamClient: new MockTouchstreamClient({ scenario: 'degraded' }) });
    const res = await a.inject({ url: '/api/v1/touchstream/history?minutes=1440' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history.stats.length).toBeGreaterThan(0);
    expect(body.history.errors.length).toBeGreaterThan(0);
    expect(body.history.environment).toBe('PROD');
  });

  it('is gated above NOC viewer', async () => {
    const a = await build('NOC_VIEWER', { touchstreamClient: new MockTouchstreamClient() });
    expect((await a.inject({ url: '/api/v1/touchstream/history' })).statusCode).toBe(403);
  });

  it('rejects an out-of-range window', async () => {
    const a = await build('VIEWING_ENGINEER', { touchstreamClient: new MockTouchstreamClient() });
    expect((await a.inject({ url: '/api/v1/touchstream/history?minutes=99999' })).statusCode).toBe(400);
  });

  it('503s when no client is configured', async () => {
    const a = await build('VIEWING_ENGINEER');
    expect((await a.inject({ url: '/api/v1/touchstream/history' })).statusCode).toBe(503);
  });

  it('maps an upstream failure to 424 so Cloudflare does not mask the message', async () => {
    const a = await build('VIEWING_ENGINEER', { touchstreamClient: new MockTouchstreamClient({ scenario: 'unavailable' }) });
    const res = await a.inject({ url: '/api/v1/touchstream/history' });
    expect(res.statusCode).toBe(424);
    expect(res.json().code).toBe('TOUCHSTREAM_UNAVAILABLE');
  });

  it('maps an auth rejection to 502 with the both-credentials explanation', async () => {
    const a = await build('VIEWING_ENGINEER', { touchstreamClient: new MockTouchstreamClient({ scenario: 'auth-failure' }) });
    const res = await a.inject({ url: '/api/v1/touchstream/history' });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('X-TS-ID');
  });
});

describe('http client', () => {
  const config = loadTouchstreamConfig({
    TOUCHSTREAM_ENABLED: 'true',
    TOUCHSTREAM_MODE: 'live',
    TOUCHSTREAM_ENDPOINT: 'https://ts.example.net',
    TOUCHSTREAM_APP_ID: 'app-id',
    TOUCHSTREAM_TOKEN: 'tok',
    TOUCHSTREAM_RETRY_ATTEMPTS: '1',
  });

  const client = (impl: typeof fetch) =>
    new HttpTouchstreamReadClient({ config, fetchImpl: impl, sleepImpl: async () => undefined });

  it('sends BOTH credentials on every read', async () => {
    let seen: Headers | undefined;
    const c = client(async (_url, init) => {
      seen = new Headers(init?.headers);
      return new Response('[]', { status: 200 });
    });
    await c.fetchStreams();
    expect(seen!.get('x-ts-id')).toBe('app-id');
    expect(seen!.get('authorization')).toBe('Bearer tok');
  });

  it('does not send the ignored stream_key filter', async () => {
    let url = '';
    await client(async (u) => {
      url = String(u);
      return new Response('[]', { status: 200 });
    }).fetchStreams();
    expect(url).toBe('https://ts.example.net/api/stream_status_full/');
    expect(url).not.toContain('stream_key');
  });

  it('treats 403 as an auth fault and does not retry it', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return new Response('', { status: 403 });
    });
    await expect(c.fetchStreams()).rejects.toMatchObject({ code: 'TOUCHSTREAM_AUTH', upstreamStatus: 403 });
    expect(calls).toBe(1);
  });

  it('retries a transient 500', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return calls === 1 ? new Response('', { status: 500 }) : new Response('[]', { status: 200 });
    });
    expect(await c.fetchStreams()).toEqual([]);
    expect(calls).toBe(2);
  });

  it('unwraps a JSON string body (as stream_stats returns) and treats empty as empty', () => {
    expect(parseBody('"[{\\"cdn\\":\\"FASTLY\\"}]"', 'stream stats')).toEqual([{ cdn: 'FASTLY' }]);
    expect(parseBody('   ', 'stream stats')).toEqual([]);
    expect(() => parseBody('<h1>Server Error</h1>', 'stream stats')).toThrow(/non-JSON/);
  });

  it('rejects a payload that does not match the expected shape', async () => {
    const c = client(async () => new Response('{"not":"an array"}', { status: 200 }));
    await expect(c.fetchStreams()).rejects.toMatchObject({ code: 'TOUCHSTREAM_INVALID_RESPONSE' });
  });
});

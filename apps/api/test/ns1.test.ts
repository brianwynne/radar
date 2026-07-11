import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  loadNs1Config,
  createNs1Client,
  HttpNs1ReadClient,
  MockNs1ReadClient,
  Ns1Error,
} from '../src/ns1/index.js';
import { RECORD_LIVE_RTE_IE_A } from '../src/ns1/fixtures.js';

const KEY = 'ns1-secret-key-do-not-log';

/** A fetch double that records calls and returns responses from a handler. */
function recordingFetch(handler: (url: string, init: RequestInit | undefined, call: number) => Response | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const out = handler(String(input), init, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const httpClient = (over: Partial<ConstructorParameters<typeof HttpNs1ReadClient>[0]> = {}, fetchImpl?: typeof fetch) =>
  new HttpNs1ReadClient({
    baseUrl: 'https://api.nsone.net/v1',
    apiKey: KEY,
    timeoutMs: 1000,
    maxRetries: 2,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
    ...over,
  });

describe('loadNs1Config', () => {
  it('defaults to mock mode with no credential required', () => {
    const c = loadNs1Config({});
    expect(c.mode).toBe('mock');
    expect(c.apiKey).toBeUndefined();
    expect(c.baseUrl).toBe('https://api.nsone.net/v1');
  });

  it('normalises a trailing slash on the base URL', () => {
    expect(loadNs1Config({ NS1_API_BASE: 'https://api.nsone.net/v1/' }).baseUrl).toBe('https://api.nsone.net/v1');
  });

  it('live mode requires an API key', () => {
    expect(() => loadNs1Config({ RADAR_MODE: 'live' })).toThrow(/requires a read-only NS1 API key/);
  });

  it('live mode requires an HTTPS base URL', () => {
    expect(() => loadNs1Config({ RADAR_MODE: 'live', NS1_API_KEY: KEY, NS1_API_BASE: 'http://api.nsone.net/v1' })).toThrow(
      /must use HTTPS/,
    );
  });

  it('live mode accepts a key from the environment', () => {
    const c = loadNs1Config({ RADAR_MODE: 'live', NS1_API_KEY: KEY });
    expect(c.mode).toBe('live');
    expect(c.apiKey).toBe(KEY);
  });

  it('is surfaced on the app config (mock by default)', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).ns1.mode).toBe('mock');
  });
});

describe('HttpNs1ReadClient — request contract', () => {
  it('issues GET with X-NSONE-Key, Accept and User-Agent to the right URL', async () => {
    const { fn, calls } = recordingFetch(() => ok(RECORD_LIVE_RTE_IE_A));
    await httpClient({}, fn).getRecord('rte.ie', 'live.rte.ie', 'A', 'corr-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.nsone.net/v1/zones/rte.ie/live.rte.ie/A');
    expect(calls[0].init?.method).toBe('GET');
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h['X-NSONE-Key']).toBe(KEY);
    expect(h['Accept']).toBe('application/json');
    expect(h['User-Agent']).toMatch(/^radar\//);
    expect(h['X-Correlation-ID']).toBe('corr-1');
  });

  it('encodes path components', async () => {
    const { fn, calls } = recordingFetch(() => ok({ zone: 'weird zone/../x' }));
    await httpClient({}, fn).getZone('weird zone/../x');
    expect(calls[0].url).toBe('https://api.nsone.net/v1/zones/weird%20zone%2F..%2Fx');
  });

  it('builds only an allow-listed activity query', async () => {
    const { fn, calls } = recordingFetch(() => ok([]));
    await httpClient({}, fn).getActivity({ limit: 5 });
    expect(calls[0].url).toBe('https://api.nsone.net/v1/account/activity?limit=5');
  });

  it('rejects an insecure (non-HTTPS) base URL at construction', () => {
    expect(() => httpClient({ baseUrl: 'http://api.nsone.net/v1' })).toThrow(/HTTPS/);
  });

  it('preserves the raw response exactly (unknown fields, answer and filter order)', async () => {
    const { fn } = recordingFetch(() => ok(RECORD_LIVE_RTE_IE_A));
    const raw = (await httpClient({}, fn).getRecord('rte.ie', 'live.rte.ie', 'A')) as Record<string, unknown>;
    expect(raw).toEqual(RECORD_LIVE_RTE_IE_A);
    const answers = raw.answers as { id: string }[];
    expect(answers.map((a) => a.id)).toEqual(['ans-realta', 'ans-fastly', 'ans-akamai', 'ans-cloudfront']);
    const filters = raw.filters as { filter: string }[];
    expect(filters.map((f) => f.filter)).toEqual([
      'up',
      'geotarget_country',
      'netfence_asn',
      'netfence_prefix',
      'weighted_shuffle',
      'select_first_n',
    ]);
    expect(raw._radar_note).toBeDefined(); // unknown field kept
  });
});

describe('HttpNs1ReadClient — error handling', () => {
  it('maps 401/403 to NS1_AUTH without retrying, leaking no key', async () => {
    const { fn, calls } = recordingFetch(() => new Response('nope', { status: 401 }));
    const err = await httpClient({}, fn)
      .listZones()
      .catch((e: unknown) => e as Ns1Error);
    expect(err).toBeInstanceOf(Ns1Error);
    expect((err as Ns1Error).code).toBe('NS1_AUTH');
    expect(calls).toHaveLength(1); // not retried
    expect(JSON.stringify(err) + (err as Error).message).not.toContain(KEY);
  });

  it('maps 404 to NS1_NOT_FOUND and 429 to NS1_RATE_LIMITED (no retry)', async () => {
    const notFound = await httpClient({}, recordingFetch(() => new Response('', { status: 404 })).fn)
      .getZone('nope.example')
      .catch((e) => e as Ns1Error);
    expect(notFound.code).toBe('NS1_NOT_FOUND');
    const limited = await httpClient({}, recordingFetch(() => new Response('', { status: 429 })).fn)
      .listZones()
      .catch((e) => e as Ns1Error);
    expect(limited.code).toBe('NS1_RATE_LIMITED');
  });

  it('retries a transient 500 then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fn, calls } = recordingFetch((_u, _i, call) =>
      call === 1 ? new Response('', { status: 503 }) : ok([{ zone: 'rte.ie' }]),
    );
    const res = await httpClient({ sleep }, fn).listZones();
    expect(res).toEqual([{ zone: 'rte.ie' }]);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on timeout and reports NS1_UPSTREAM_TIMEOUT', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { fn, calls } = recordingFetch(() => timeout);
    const err = await httpClient({ maxRetries: 1 }, fn)
      .listZones()
      .catch((e) => e as Ns1Error);
    expect(err.code).toBe('NS1_UPSTREAM_TIMEOUT');
    expect(calls).toHaveLength(2); // initial + 1 retry
  });

  it('rejects a wire-shape mismatch as NS1_INVALID_RESPONSE', async () => {
    const { fn } = recordingFetch(() => ok({ domain: 'x', answers: 'not-an-array' }));
    const err = await httpClient({}, fn)
      .getRecord('rte.ie', 'live.rte.ie', 'A')
      .catch((e) => e as Ns1Error);
    expect(err.code).toBe('NS1_INVALID_RESPONSE');
  });
});

describe('MockNs1ReadClient', () => {
  const mock = new MockNs1ReadClient();

  it('returns fixtures without any credential', async () => {
    expect(await mock.listZones()).toBeInstanceOf(Array);
    expect((await mock.getRecord('rte.ie', 'live.rte.ie', 'a')) as Record<string, unknown>).toMatchObject({
      domain: 'live.rte.ie',
      type: 'A',
    });
    expect(await mock.getActivity()).toBeInstanceOf(Array);
  });

  it('raises NS1_NOT_FOUND for unknown resources', async () => {
    await expect(mock.getRecord('rte.ie', 'unknown.rte.ie', 'A')).rejects.toBeInstanceOf(Ns1Error);
    await expect(mock.getZone('nope.example')).rejects.toMatchObject({ code: 'NS1_NOT_FOUND' });
  });

  it('returns deep clones so callers cannot mutate the fixtures', async () => {
    const first = (await mock.getRecord('rte.ie', 'live.rte.ie', 'A')) as { answers: unknown[] };
    first.answers.length = 0;
    const second = (await mock.getRecord('rte.ie', 'live.rte.ie', 'A')) as { answers: unknown[] };
    expect(second.answers).toHaveLength(4);
  });
});

describe('createNs1Client factory', () => {
  it('builds the mock client in mock mode', () => {
    expect(createNs1Client(loadNs1Config({}))).toBeInstanceOf(MockNs1ReadClient);
  });

  it('builds the live HTTP client in live mode', async () => {
    const { fn, calls } = recordingFetch(() => ok([]));
    const client = createNs1Client(loadNs1Config({ RADAR_MODE: 'live', NS1_API_KEY: KEY }), { fetchImpl: fn });
    expect(client).toBeInstanceOf(HttpNs1ReadClient);
    await client.listZones();
    expect(calls[0].init?.method).toBe('GET');
  });

  it('exposes GET-only methods (no write verbs on the client)', () => {
    const client = createNs1Client(loadNs1Config({}));
    for (const verb of ['put', 'post', 'delete', 'patch', 'request', 'fetch']) {
      expect((client as unknown as Record<string, unknown>)[verb]).toBeUndefined();
    }
  });
});

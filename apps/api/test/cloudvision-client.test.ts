// CloudVision clients: the mock (scenario-driven, no credentials) and the live HTTP client
// (transport, inventory + NetDB parsing, retry, auth). The live client is exercised with an
// injected fetch — no real CloudVision is contacted. Tokens must never leak into errors.
import { describe, it, expect, vi } from 'vitest';
import { MockCloudVisionClient, DisabledCloudVisionClient } from '../src/cloudvision/mock-client.js';
import { HttpCloudVisionReadClient } from '../src/cloudvision/http-client.js';
import { CloudVisionError } from '../src/cloudvision/errors.js';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from '../src/cloudvision/classification-rules.js';
import { MOCK_EDGE_DEVICE_IDS } from '../src/cloudvision/fixtures.js';

const NOW = Date.parse('2026-07-15T12:00:00Z');
const mockOpts = {
  staleAfterSeconds: 30, expectedDeviceIds: MOCK_EDGE_DEVICE_IDS, classificationRules: DEFAULT_CLASSIFICATION_RULES,
  providerForAsn: DEFAULT_PROVIDER_FOR_ASN, warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound' as const, now: () => NOW,
};

describe('MockCloudVisionClient', () => {
  it('returns a synthetic snapshot for the normal scenario', async () => {
    const snap = await new MockCloudVisionClient({ ...mockOpts, scenario: 'normal' }).getSnapshot();
    expect(snap.source).toBe('mock');
    expect(snap.provenance.synthetic).toBe(true);
    expect(snap.devices).toHaveLength(2);
    expect(snap.interfaces.some((i) => i.provider === 'Eir')).toBe(true);
  });

  it('raises CLOUDVISION_AUTH for the auth-failure scenario', async () => {
    const err = await new MockCloudVisionClient({ ...mockOpts, scenario: 'auth-failure' }).getSnapshot().catch((e: unknown) => e as CloudVisionError);
    expect(err).toBeInstanceOf(CloudVisionError);
    expect((err as CloudVisionError).code).toBe('CLOUDVISION_AUTH');
  });
});

describe('DisabledCloudVisionClient', () => {
  it('returns an honest not-connected snapshot', async () => {
    const snap = await new DisabledCloudVisionClient(30, MOCK_EDGE_DEVICE_IDS, () => NOW).getSnapshot();
    expect(snap.source).toBe('disabled');
    expect(snap.devices).toHaveLength(0);
    expect(snap.summary.totalEdgeThroughputBps).toBeNull();
  });
});

const TOKEN = 'super-secret-token';
const INVENTORY = [
  { result: { value: { key: { device_id: 'DEV1' }, hostname: 'edge1.rte.ie', model_name: 'DCS-7280SR3', software_version: '4.31.2F', streaming_status: 'STREAMING_STATUS_ACTIVE' } } },
];
const IF_STATE = { notifications: [{ updates: { Ethernet1: { description: 'Eir PNI Dublin', adminStatus: 'up', linkStatus: 'up', speed: 100e9, inBitsRate: 8e9, outBitsRate: 40e9, counters: { inErrors: 0, outErrors: 1, inDiscards: 0, outDiscards: 0 } } } }] };
const BGP_STATE = { notifications: [{ updates: { '185.6.36.1': { asn: 5466, state: 'Established', uptime: 8640, prefixesReceived: 850000, prefixesAdvertised: 40 } } }] };

function httpClient(overrides: Partial<ConstructorParameters<typeof HttpCloudVisionReadClient>[0]> = {}, fetchImpl?: typeof fetch) {
  return new HttpCloudVisionReadClient({
    endpoint: 'https://cvp.example', token: TOKEN, timeoutMs: 2000, maxRetries: 2, verifyTls: true,
    staleAfterSeconds: 30, expectedDeviceIds: [], classificationRules: DEFAULT_CLASSIFICATION_RULES, providerForAsn: DEFAULT_PROVIDER_FOR_ASN,
    warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound', now: () => NOW, sleep: async () => undefined, random: () => 0.5,
    fetchImpl, ...overrides,
  });
}

function routingFetch(handler: (path: string, call: number) => Response | Error): { fn: typeof fetch; calls: { url: string; auth: string | null }[] } {
  const calls: { url: string; auth: string | null }[] = [];
  const counts = new Map<string, number>();
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace('https://cvp.example', '');
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, auth });
    const key = path.split('?')[0];
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const r = handler(path, n);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('HttpCloudVisionReadClient', () => {
  it('discovers devices, interfaces and BGP peers and classifies them', async () => {
    const { fn, calls } = routingFetch((path) => {
      if (path.includes('/inventory/v1/Device/all')) return ok(INVENTORY);
      if (path.includes('/intfStatus')) return ok(IF_STATE);
      if (path.includes('peerInfoStatus')) return ok(BGP_STATE);
      return new Response('', { status: 404 });
    });
    const snap = await httpClient({}, fn).getSnapshot('cid-1');
    expect(snap.source).toBe('cloudvision');
    expect(snap.devices).toHaveLength(1);
    expect(snap.devices[0]).toMatchObject({ id: 'DEV1', hostname: 'edge1.rte.ie', streaming: true });
    const eir = snap.interfaces.find((i) => i.name === 'Ethernet1')!;
    expect(eir).toMatchObject({ provider: 'Eir', linkType: 'PRIVATE_PEERING', bandwidthSource: 'REPORTED' });
    expect(eir.utilisationPercent).toBeCloseTo(40, 5);
    expect(snap.bgpPeers[0]).toMatchObject({ peerAsn: 5466, state: 'ESTABLISHED', established: true });
    // Every request carried the bearer token.
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('parses the real CVaaS camelCase inventory shape and INACTIVE streaming', async () => {
    // gRPC-gateway proto3 JSON is camelCase (deviceId/modelName/streamingStatus).
    const camel = [
      { result: { value: { key: { deviceId: 'FGN1' }, hostname: 'spine-a', modelName: 'DCS-7280CR3-96', softwareVersion: '4.30.5M', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } },
      { result: { value: { key: { deviceId: 'FGN2' }, hostname: 'spine-b', modelName: 'DCS-7280CR3-96', softwareVersion: '4.30.5M', streamingStatus: 'STREAMING_STATUS_INACTIVE' } } },
    ];
    const { fn } = routingFetch((path) => (path.includes('/Device/all') ? ok(camel) : ok({ notifications: [] })));
    const snap = await httpClient({}, fn).getSnapshot();
    expect(snap.devices).toHaveLength(2);
    expect(snap.devices[0]).toMatchObject({ id: 'FGN1', hostname: 'spine-a', modelName: 'DCS-7280CR3-96', streaming: true });
    expect(snap.devices[1]).toMatchObject({ id: 'FGN2', streaming: false }); // INACTIVE ≠ streaming
  });

  it('retries a transient 503 then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fn } = routingFetch((path, call) => {
      if (path.includes('/Device/all')) return call === 1 ? new Response('', { status: 503 }) : ok(INVENTORY);
      if (path.includes('/intfStatus')) return ok(IF_STATE);
      if (path.includes('peerInfoStatus')) return ok(BGP_STATE);
      return new Response('', { status: 404 });
    });
    const snap = await httpClient({ sleep }, fn).getSnapshot();
    expect(snap.devices).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to CLOUDVISION_AUTH and never leaks the token', async () => {
    const { fn } = routingFetch(() => new Response('nope', { status: 401 }));
    const err = await httpClient({}, fn).getSnapshot().catch((e: unknown) => e as CloudVisionError);
    expect(err).toBeInstanceOf(CloudVisionError);
    expect((err as CloudVisionError).code).toBe('CLOUDVISION_AUTH');
    expect(JSON.stringify(err) + (err as Error).message + ((err as Error).stack ?? '')).not.toContain(TOKEN);
  });

  it('degrades a failed interface fetch to no interfaces (device still present)', async () => {
    const warn = vi.fn();
    const { fn } = routingFetch((path) => {
      if (path.includes('/Device/all')) return ok(INVENTORY);
      if (path.includes('/intfStatus')) return new Response('', { status: 500 });
      if (path.includes('peerInfoStatus')) return ok(BGP_STATE);
      return new Response('', { status: 404 });
    });
    const snap = await httpClient({ logger: { warn } }, fn).getSnapshot();
    expect(snap.devices).toHaveLength(1);
    expect(snap.interfaces).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});

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
// analytics-dataset shapes (as verified live against CVaaS): every field is `{ key, value }`.
const TS = '1784137260000000000'; // ns epoch
const wrap = (value: unknown) => ({ key: 'k', value });
// The 10-second `rates` node carries octet fields as bare `{float}` scalars (octets/sec).
const rate = (v: number) => wrap({ float: v });
// The 1-minute `aggregate/rates/1m` node carries rate-STATS `{avg,max,min,…}` — used (matched
// with the 1-minute utilisation) to derive the stable interface speed.
const stat = (avg: number) => wrap({ avg: { float: avg }, max: { float: avg }, min: { float: avg }, stddev: { float: 0 }, weight: { float: 1 } });
const IF_LIST = { notifications: [{ updates: { Ethernet1: wrap({ ptr: ['x'] }) } }] };
const IF_RATES = { notifications: [{ timestamp: TS, updates: { inOctets: rate(1e9), outOctets: rate(5e9), inErrors: rate(0), outErrors: rate(2), inDiscards: rate(0), outDiscards: rate(1) } }] };
// 1-minute averages (may differ from the 10s snapshot): in 1e9 oct/s ÷ 8% util, out 5e9 ÷ 40% → 100 Gbps.
const IF_AGG_1M = { notifications: [{ timestamp: TS, updates: { inOctets: stat(1e9), outOctets: stat(5e9) } }] };
const IF_UTIL = { notifications: [{ updates: { 'inOctets-utilization': wrap({ float: 8 }), 'outOctets-utilization': wrap({ float: 40 }) } }] };
const BGP_LIST = { notifications: [{ updates: { '185.6.36.1': wrap({ ptr: ['x'] }) } }] };
const BGP_LEAF = { notifications: [{ timestamp: TS, updates: { bgpState: wrap({ Name: 'Established', Value: { int: 6 } }), bgpPeerAs: wrap({ value: { int: 5466 } }), bgpPeerLocalAddr: wrap('185.6.36.2'), bgpPeerDescription: wrap('[Transit] Cogent 3-002188930') } }] };
const PC_LIST = { notifications: [{ updates: { 'Port-Channel7': wrap({ ptr: ['x'] }) } }] };
const PC_MEMBERS = { notifications: [{ updates: { Ethernet1: wrap({ ptr: ['x'] }) } }] }; // Ethernet1 ∈ Port-Channel7
// Device Sysdb interface-status: the flat map resolves each interface to a pointer; the record
// carries the authoritative speed (physical port → speedEnum; speedMbps 0). speed100Gbps → 100G.
const IF_STATUS_MAP = { notifications: [{ updates: { Ethernet1: wrap({ ptr: ['Sysdb', 'interface', 'status', 'eth', 'phy', 'slice', 'Linecard1', 'intfStatus', 'Ethernet1'] }) } }] };
const IF_STATUS_REC = { notifications: [{ updates: { speedEnum: wrap({ Name: 'speed100Gbps', Value: { int: 10 } }), speedMbps: wrap({ int: 0 }) } }] };
// Device Sysdb config: the flat map resolves each interface to its config record, which carries
// the operator's description.
const IF_CONFIG_MAP = { notifications: [{ updates: { Ethernet1: wrap({ ptr: ['Sysdb', 'interface', 'config', 'eth', 'phy', 'slice', 'Linecard1', 'intfConfig', 'Ethernet1'] }) } }] };
const IF_CONFIG_REC = { notifications: [{ updates: { description: wrap('[Po7] Eir') } }] };

/** Route a request path to the right analytics fixture. */
function analyticsHandler(path: string): Response {
  if (path.includes('/inventory/v1/Device/all')) return ok(INVENTORY);
  if (path.endsWith('/status/all/intfStatus')) return ok(IF_STATUS_MAP); // real-speed pointer map
  if (path.includes('/intfStatus/Ethernet1')) return ok(IF_STATUS_REC); // real-speed record (100G)
  if (path.endsWith('/config/all/intfConfig')) return ok(IF_CONFIG_MAP); // description pointer map
  if (path.includes('/intfConfig/Ethernet1')) return ok(IF_CONFIG_REC); // description record
  if (path.includes('/utilisation') || path.includes('/utilization')) return ok(IF_UTIL);
  if (path.endsWith('/expectedMembers')) return ok(PC_MEMBERS);
  if (path.endsWith('/portchannel')) return ok(PC_LIST);
  if (path.endsWith('/interfaces/data')) return ok(IF_LIST);
  if (path.includes('/aggregate/rates/1m')) return ok(IF_AGG_1M); // 1-minute averages (speed derivation)
  if (path.endsWith('/rates')) return ok(IF_RATES); // per-interface 10-second rate node (bandwidth)
  if (path.includes('/bgpPeerInfoStatusEntry/')) return ok(BGP_LEAF);
  if (path.endsWith('/bgpPeerInfoStatusEntry')) return ok(BGP_LIST);
  return new Response('', { status: 404 });
}

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
  it('discovers devices + interface bandwidth (analytics rates) and BGP peers', async () => {
    const { fn, calls } = routingFetch((path) => analyticsHandler(path));
    const snap = await httpClient({}, fn).getSnapshot('cid-1');
    expect(snap.source).toBe('cloudvision');
    expect(snap.devices).toHaveLength(1);
    expect(snap.devices[0]).toMatchObject({ id: 'DEV1', hostname: 'edge1.rte.ie', streaming: true });
    // Interface: outOctets 5e9/s ×8 = 40 Gbps bandwidth (10s rate); speed 100 Gbps is READ from
    // the Sysdb status record (speedEnum "speed100Gbps"), not derived; utilisation = 40/100 = 40%.
    const eth1 = snap.interfaces.find((i) => i.name === 'Ethernet1')!;
    expect(eth1.outBps).toBe(40e9);
    expect(eth1.inBps).toBe(8e9);
    expect(eth1.utilisationPercent).toBeCloseTo(40, 1);
    expect(eth1.speedBps).toBeCloseTo(100e9, -8);
    expect(eth1.description).toBe('[Po7] Eir'); // read from the Sysdb config record
    expect(eth1.bandwidthSource).toBe('REPORTED');
    expect(eth1.memberOf).toBe('Port-Channel7'); // LAG membership from portchannel/expectedMembers
    expect(eth1.observedAt).toBe(new Date(Number(BigInt(TS) / 1_000_000n)).toISOString());
    // BGP peer: state + ASN + provider parsed from the "[Transit] Cogent" description.
    const peer = snap.bgpPeers.find((p) => p.peerAddress === '185.6.36.1')!;
    expect(peer).toMatchObject({ state: 'ESTABLISHED', peerAsn: 5466, provider: 'Cogent', established: true });
    // Every request carried the bearer token.
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('falls back to deriving speed when the Sysdb status record has no usable speed', async () => {
    // Status map present but the record reports speedUnknown / speedMbps 0 → realSpeed is null,
    // so speed is derived from the matched 1-minute rate (5e9×8=40G) ÷ utilisation (40%) = 100G.
    const { fn } = routingFetch((path) => {
      if (path.includes('/intfStatus/Ethernet1')) return ok({ notifications: [{ updates: { speedEnum: wrap({ Name: 'speedUnknown', Value: { int: 0 } }), speedMbps: wrap({ int: 0 }) } }] });
      return analyticsHandler(path);
    });
    const snap = await httpClient({}, fn).getSnapshot();
    const eth1 = snap.interfaces.find((i) => i.name === 'Ethernet1')!;
    expect(eth1.speedBps).toBeCloseTo(100e9, -8); // derived fallback still resolves the speed
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
      return analyticsHandler(path);
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
      if (path.endsWith('/interfaces/data')) return new Response('', { status: 500 }); // interface list fails
      return analyticsHandler(path);
    });
    const snap = await httpClient({ logger: { warn } }, fn).getSnapshot();
    expect(snap.devices).toHaveLength(1);
    expect(snap.interfaces).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});

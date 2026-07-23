// CloudVision poller: latest-snapshot retention, bounded history ring buffer, no overlapping
// polls, failure preserves the last good snapshot with backoff, and connector status.
import { describe, it, expect, vi } from 'vitest';
import { CloudVisionPoller } from '../src/cloudvision/poller.js';
import { CloudVisionError } from '../src/cloudvision/errors.js';
import type { CloudVisionClient, NetworkStateSnapshot } from '../src/cloudvision/types.js';

let clock = Date.parse('2026-07-15T12:00:00Z');
const now = () => clock;

function snapshot(edgeBps: number): NetworkStateSnapshot {
  return {
    capturedAt: new Date(clock).toISOString(),
    source: 'mock',
    devices: [], interfaces: [], bgpPeers: [], linkGroups: [],
    summary: { totalEdgeThroughputBps: edgeBps, totalPeeringThroughputBps: edgeBps, totalTransitThroughputBps: 0, operationalCapacityBps: 100e9, operationalHeadroomBps: 100e9 - edgeBps, unhealthyLinks: 0, unhealthyBgpPeers: 0, deviceCount: 2, interfaceCount: 5, unknownInterfaceCount: 0, telemetryAgeSeconds: 0 },
    freshness: { level: 'FRESH', ageSeconds: 0, staleAfterSeconds: 30 },
    completeness: { expectedDevices: 2, observedDevices: 2, interfacesWithBandwidth: 5, totalInterfaces: 5, level: 'complete' },
    warnings: [],
    provenance: { source: 'mock', synthetic: true, readOnly: true, note: '' },
  };
}

/** A client whose behaviour is programmable per call. */
class ScriptedClient implements CloudVisionClient {
  calls = 0;
  constructor(private readonly script: (call: number) => NetworkStateSnapshot | Error) {}
  async getSnapshot(): Promise<NetworkStateSnapshot> {
    this.calls += 1;
    const r = this.script(this.calls);
    if (r instanceof Error) throw r;
    return r;
  }
}

describe('CloudVisionPoller delivery history (OTT trend)', () => {
  const iface = (deviceId: string, name: string, provider: string, linkType: string, primaryBps: number) =>
    ({ deviceId, name, provider, linkType, memberOf: null, primaryBps } as unknown as NetworkStateSnapshot['interfaces'][number]);
  it('accumulates per-provider Citywest/Parkwest delivery egress, excluding cloud peers', async () => {
    const snap: NetworkStateSnapshot = {
      ...snapshot(0),
      interfaces: [
        iface('JPN2508A7QM', 'Port-Channel7', 'Eir', 'PRIVATE_PEERING', 40e9), // Citywest
        iface('JPA2430A9R2', 'Port-Channel7', 'Eir', 'PRIVATE_PEERING', 90e9), // Parkwest
        iface('JPN2508A7QM', 'Port-Channel9', 'Microsoft', 'PRIVATE_PEERING', 70e9), // cloud peer — excluded
      ],
    };
    const poller = new CloudVisionPoller({ client: new ScriptedClient(() => snap), source: 'mock', intervalMs: 10_000, now });
    await poller.runOnce();
    const h = poller.getDeliveryHistory();
    expect(h).toHaveLength(1);
    expect(h[0].byProvider.Eir).toEqual({ citywest: 40e9, parkwest: 90e9 });
    expect(h[0].byProvider.Microsoft).toBeUndefined();
  });
});

describe('CloudVisionPoller', () => {
  it('retains the latest snapshot and appends bounded history', async () => {
    const client = new ScriptedClient((n) => snapshot(n * 10e9));
    const poller = new CloudVisionPoller({ client, source: 'mock', intervalMs: 10_000, historyLimit: 2, now });
    await poller.runOnce();
    clock += 10_000;
    await poller.runOnce();
    clock += 10_000;
    await poller.runOnce();
    expect(poller.getLatest()!.summary.totalEdgeThroughputBps).toBe(30e9);
    // historyLimit 2 → only the last two points retained.
    expect(poller.getHistory()).toHaveLength(2);
    expect(poller.getHistory().map((h) => h.totalEdgeThroughputBps)).toEqual([20e9, 30e9]);
  });

  it('preserves the last good snapshot on failure and records the error', async () => {
    const client = new ScriptedClient((n) => (n === 1 ? snapshot(40e9) : new CloudVisionError('CLOUDVISION_UPSTREAM_TIMEOUT', undefined, { transient: true })));
    const poller = new CloudVisionPoller({ client, source: 'cloudvision', intervalMs: 10_000, now });
    await poller.runOnce();
    const res = await poller.runOnce();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('CLOUDVISION_UPSTREAM_TIMEOUT');
    expect(poller.getLatest()!.summary.totalEdgeThroughputBps).toBe(40e9); // last good retained
    const status = poller.status();
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toBe('CLOUDVISION_UPSTREAM_TIMEOUT');
  });

  it('emits structured poll-duration + failure logs', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const client = new ScriptedClient((n) => (n === 1 ? snapshot(10e9) : new Error('boom')));
    const poller = new CloudVisionPoller({ client, source: 'cloudvision', intervalMs: 10_000, now, logger: { info, warn, error: vi.fn() } });
    await poller.runOnce();
    await poller.runOnce();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ source: 'cloudvision', durationMs: expect.any(Number), devices: 2 }), 'cloudvision poll complete');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ failures: 1, code: 'INTERNAL_ERROR' }), 'cloudvision poll failed');
  });

  it('reports status with snapshot age', async () => {
    const client = new ScriptedClient(() => snapshot(10e9));
    const poller = new CloudVisionPoller({ client, source: 'mock', intervalMs: 10_000, now });
    await poller.runOnce();
    clock += 15_000;
    const status = poller.status();
    expect(status.snapshotAgeSeconds).toBe(15);
    expect(status).toMatchObject({ enabled: true, source: 'mock', intervalMs: 10_000, historyLength: 1, deviceCount: 2 });
  });

  it('a disabled poller does not start', () => {
    const client = new ScriptedClient(() => snapshot(10e9));
    const poller = new CloudVisionPoller({ client, source: 'disabled', intervalMs: 10_000, enabled: false, now });
    poller.start();
    expect(poller.status().running).toBe(false);
  });
});

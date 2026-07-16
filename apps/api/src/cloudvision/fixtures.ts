// Deterministic SYNTHETIC fixtures for CloudVision mock mode. Each scenario returns a raw
// snapshot (vendor-neutral, pre-classification) that flows through the SAME adapter and the
// SAME backend APIs as live mode — mock changes only the data source, never the code path.
// Values are illustrative, never represented as real RTÉ telemetry.
import type { PreviousCounters, RawBgpPeer, RawInterface, RawSnapshot } from './adapter.js';
import { counterKey } from './adapter.js';

export type ScenarioName =
  | 'normal'
  | 'major-event'
  | 'eir-near-capacity'
  | 'inex-failure'
  | 'transit-failure'
  | 'bgp-failure'
  | 'stale'
  | 'counter-reset'
  | 'missing-speed'
  | 'partial-response'
  | 'auth-failure';

export const SCENARIOS: ScenarioName[] = [
  'normal', 'major-event', 'eir-near-capacity', 'inex-failure', 'transit-failure',
  'bgp-failure', 'stale', 'counter-reset', 'missing-speed', 'partial-response', 'auth-failure',
];

export const EDGE1 = 'JPE00000001';
export const EDGE2 = 'JPE00000002';
export const MOCK_EDGE_DEVICE_IDS = [EDGE1, EDGE2];

const G = 1e9;

interface ItfSpec {
  device: string; name: string; description: string;
  speedBps: number | null; outBps: number | null; inBps: number | null;
  operState?: 'up' | 'down'; inErrors?: number; outErrors?: number; inDiscards?: number; outDiscards?: number;
}

function itf(spec: ItfSpec, at: Date): RawInterface {
  const oper = spec.operState ?? 'up';
  return {
    deviceId: spec.device,
    name: spec.name,
    description: spec.description,
    adminState: 'up',
    operState: oper,
    speedBps: spec.speedBps,
    reportedInBps: oper === 'down' ? 0 : spec.inBps,
    reportedOutBps: oper === 'down' ? 0 : spec.outBps,
    inOctets: null,
    outOctets: null,
    inErrors: spec.inErrors ?? 0,
    outErrors: spec.outErrors ?? 0,
    inDiscards: spec.inDiscards ?? 0,
    outDiscards: spec.outDiscards ?? 0,
    observedAt: at,
  };
}

function peer(device: string, address: string, asn: number, state: string, at: Date, received = 850000, advertised = 40): RawBgpPeer {
  return { deviceId: device, peerAddress: address, peerAsn: asn, state, uptimeSeconds: state === 'Established' ? 864000 : 0, prefixesReceived: received, prefixesAdvertised: advertised, observedAt: at };
}

/** Base topology at throughput multiplier `m`. Two edge routers, peering + transit + core. */
function baseInterfaces(at: Date, m = 1): RawInterface[] {
  return [
    itf({ device: EDGE1, name: 'Ethernet1', description: '[Po7] Eir', speedBps: 100 * G, outBps: 40 * G * m, inBps: 8 * G, inErrors: 0, outErrors: 0 }, at),
    itf({ device: EDGE1, name: 'Ethernet2', description: '[Po1] INEX LAN#1', speedBps: 100 * G, outBps: 55 * G * m, inBps: 12 * G }, at),
    itf({ device: EDGE1, name: 'Ethernet3', description: '[Po3] Liberty Global - PX01660', speedBps: 40 * G, outBps: 18 * G * m, inBps: 4 * G }, at),
    itf({ device: EDGE1, name: 'Ethernet4', description: '[Transit] Cogent - 3-002188930', speedBps: 100 * G, outBps: 10 * G * m, inBps: 3 * G }, at),
    itf({ device: EDGE1, name: 'Ethernet5', description: 'Core spine link', speedBps: 400 * G, outBps: 120 * G, inBps: 118 * G }, at),
    itf({ device: EDGE2, name: 'Ethernet1', description: '[Po7] Eir', speedBps: 100 * G, outBps: 38 * G * m, inBps: 7 * G }, at),
    itf({ device: EDGE2, name: 'Ethernet2', description: '[Po1] INEX LAN#1', speedBps: 100 * G, outBps: 52 * G * m, inBps: 11 * G }, at),
    itf({ device: EDGE2, name: 'Ethernet4', description: '[Transit] GTT - IC-100200', speedBps: 100 * G, outBps: 9 * G * m, inBps: 2 * G }, at),
  ];
}

function basePeers(at: Date): RawBgpPeer[] {
  return [
    peer(EDGE1, '185.6.36.1', 5466, 'Established', at), // Eir
    peer(EDGE1, '194.88.240.1', 43760, 'Established', at), // INEX route server
    peer(EDGE1, '154.54.1.1', 174, 'Established', at), // Cogent transit
    peer(EDGE2, '185.6.36.2', 5466, 'Established', at),
    peer(EDGE2, '194.88.240.2', 43760, 'Established', at),
  ];
}

function baseDevices(at: Date) {
  return [
    { id: EDGE1, hostname: 'edge1.dub.rte.ie', modelName: 'DCS-7280SR3', softwareVersion: '4.31.2F', streaming: true, reachable: true, observedAt: at },
    { id: EDGE2, hostname: 'edge2.dub.rte.ie', modelName: 'DCS-7280SR3', softwareVersion: '4.31.2F', streaming: true, reachable: true, observedAt: at },
  ];
}

/** Build the raw snapshot for a scenario. `now` is epoch ms (injected for determinism). */
export function scenarioSnapshot(name: ScenarioName, now: number): RawSnapshot {
  const at = new Date(now);
  let devices = baseDevices(at);
  let interfaces = baseInterfaces(at);
  let bgpPeers = basePeers(at);
  let previousCounters: Map<string, PreviousCounters> | undefined;

  switch (name) {
    case 'normal':
      break;
    case 'major-event':
      interfaces = baseInterfaces(at, 1.6); // peering/transit ~1.6× — high but under capacity
      break;
    case 'eir-near-capacity':
      interfaces = interfaces.map((i) => (i.description === '[Po7] Eir' && i.deviceId === EDGE1 ? { ...i, reportedOutBps: 93 * G } : i));
      break;
    case 'inex-failure':
      interfaces = interfaces.map((i) => (i.description === '[Po1] INEX LAN#1' ? { ...i, operState: 'down', reportedInBps: 0, reportedOutBps: 0 } : i));
      bgpPeers = bgpPeers.map((p) => (p.peerAsn === 43760 ? { ...p, state: 'Idle', uptimeSeconds: 0 } : p));
      break;
    case 'transit-failure':
      interfaces = interfaces.map((i) => ((i.description ?? '').startsWith('Transit') ? { ...i, operState: 'down', reportedInBps: 0, reportedOutBps: 0 } : i));
      bgpPeers = bgpPeers.map((p) => (p.peerAsn === 174 ? { ...p, state: 'Idle', uptimeSeconds: 0 } : p));
      break;
    case 'bgp-failure':
      // Interface up, but the Eir session on edge1 is stuck in Active (not established).
      bgpPeers = bgpPeers.map((p) => (p.deviceId === EDGE1 && p.peerAsn === 5466 ? { ...p, state: 'Active', uptimeSeconds: 0, prefixesReceived: 0 } : p));
      break;
    case 'stale': {
      // Every observation is well beyond 2× the default max sample age (30s) → STALE.
      const old = new Date(now - 300_000);
      devices = baseDevices(old);
      interfaces = baseInterfaces(old);
      bgpPeers = basePeers(old);
      break;
    }
    case 'counter-reset': {
      // Two counter-only interfaces on edge1: one rebooted (reset → UNAVAILABLE), one rolled
      // over a 64-bit counter (derived across the wrap). No reported bps for these.
      const prevAt = new Date(now - 10_000);
      previousCounters = new Map<string, PreviousCounters>([
        [counterKey(EDGE1, 'Ethernet4'), { inOctets: 500_000_000n, outOctets: 900_000_000n, at: prevAt }],
        [counterKey(EDGE1, 'Ethernet1'), { inOctets: (1n << 64n) - 1_000_000n, outOctets: (1n << 64n) - 2_000_000n, at: prevAt }],
      ]);
      interfaces = interfaces.map((i) => {
        if (i.deviceId === EDGE1 && i.name === 'Ethernet4') {
          return { ...i, reportedInBps: null, reportedOutBps: null, inOctets: 100_000_000n, outOctets: 200_000_000n, rebooted: true };
        }
        if (i.deviceId === EDGE1 && i.name === 'Ethernet1') {
          return { ...i, reportedInBps: null, reportedOutBps: null, inOctets: 4_000_000n, outOctets: 8_000_000n }; // wrapped past 2^64
        }
        return i;
      });
      break;
    }
    case 'missing-speed':
      interfaces = interfaces.map((i) => (i.deviceId === EDGE1 && i.name === 'Ethernet3' ? { ...i, speedBps: null } : i));
      break;
    case 'partial-response':
      // Only edge1 responded; edge2 is missing from the API response entirely.
      devices = devices.filter((d) => d.id === EDGE1);
      interfaces = interfaces.filter((i) => i.deviceId === EDGE1);
      bgpPeers = bgpPeers.filter((p) => p.deviceId === EDGE1);
      break;
    case 'auth-failure':
      // Represented by the mock client raising CLOUDVISION_AUTH; no snapshot is produced.
      break;
  }

  return { devices, interfaces, bgpPeers, previousCounters };
}

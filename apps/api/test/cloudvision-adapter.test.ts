// CloudVision adapter: raw → canonical snapshot. Aggregate utilisation is total/total (never
// an average of percentages); classification, freshness, BGP normalisation, completeness and
// warnings are all exercised through the shared scenario fixtures.
import { describe, it, expect } from 'vitest';
import { buildSnapshot, normaliseBgpState, type AdapterConfig, type RawSnapshot } from '../src/cloudvision/adapter.js';
import { scenarioSnapshot, MOCK_EDGE_DEVICE_IDS, EDGE1, EDGE2 } from '../src/cloudvision/fixtures.js';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from '../src/cloudvision/classification-rules.js';
import type { ClassificationRule } from '../src/cloudvision/classification.js';

const NOW = Date.parse('2026-07-15T12:00:00Z');

const cfg = (over: Partial<AdapterConfig> = {}): AdapterConfig => ({
  source: 'mock', synthetic: true, now: NOW, staleAfterSeconds: 30, expectedDeviceIds: MOCK_EDGE_DEVICE_IDS,
  classificationRules: DEFAULT_CLASSIFICATION_RULES, providerForAsn: DEFAULT_PROVIDER_FOR_ASN,
  warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound', ...over,
});

const scenario = (name: Parameters<typeof scenarioSnapshot>[0], over: Partial<AdapterConfig> = {}) =>
  buildSnapshot(scenarioSnapshot(name, NOW), cfg(over));

describe('aggregate utilisation is total/total (never an average of percentages)', () => {
  it('divides summed throughput by summed capacity', () => {
    const rules: ClassificationRule[] = [{ match: { kind: 'description_exact', description: 'ProvX' }, linkType: 'PRIVATE_PEERING', provider: 'ProvX' }];
    const at = new Date(NOW);
    const mk = (name: string, speed: number, out: number) => ({
      deviceId: 'D1', name, description: 'ProvX', adminState: 'up' as const, operState: 'up' as const, speedBps: speed,
      reportedInBps: 0, reportedOutBps: out, inOctets: null, outOctets: null, inErrors: 0, outErrors: 0, inDiscards: 0, outDiscards: 0, observedAt: at,
    });
    const raw: RawSnapshot = {
      devices: [{ id: 'D1', hostname: 'd1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: at }],
      interfaces: [mk('Ethernet1', 100e9, 90e9), mk('Ethernet2', 300e9, 30e9)], // 90% and 10% individually
      bgpPeers: [],
    };
    const snap = buildSnapshot(raw, cfg({ classificationRules: rules, expectedDeviceIds: ['D1'] }));
    const group = snap.linkGroups.find((g) => g.key === 'provx')!;
    // total 120G / total 400G = 30% — NOT the 50% average of 90% and 10%.
    expect(group.utilisationPercent).toBeCloseTo(30, 5);
    expect(group.capacityBps).toBe(400e9);
    expect(group.currentBps).toBe(120e9);
    expect(group.headroomBps).toBe(280e9);
  });
});

describe('normal scenario', () => {
  const snap = scenario('normal');
  it('classifies interfaces and keeps configured vs observed distinct', () => {
    const eir = snap.interfaces.find((i) => i.deviceId === EDGE1 && i.name === 'Ethernet1')!;
    expect(eir).toMatchObject({ provider: 'Eir', linkType: 'PRIVATE_PEERING', bandwidthSource: 'REPORTED' });
    expect(eir.utilisationPercent).toBeCloseTo(40, 5); // 40G / 100G
  });
  it('summarises devices, peering/transit totals and no unknowns', () => {
    expect(snap.summary.deviceCount).toBe(2);
    expect(snap.summary.unknownInterfaceCount).toBe(0);
    expect(snap.summary.totalPeeringThroughputBps).toBeGreaterThan(0);
    expect(snap.summary.totalTransitThroughputBps).toBeGreaterThan(0);
    expect(snap.freshness.level).toBe('FRESH');
    expect(snap.completeness.level).toBe('complete');
  });
});

describe('failure scenarios', () => {
  it('inex-failure: link down + BGP idle → unhealthy counts and warnings', () => {
    const snap = scenario('inex-failure');
    const inex = snap.interfaces.filter((i) => i.provider === 'INEX');
    expect(inex.every((i) => i.operState === 'down' && i.status === 'down')).toBe(true);
    expect(snap.summary.unhealthyLinks).toBeGreaterThan(0);
    const inexPeers = snap.bgpPeers.filter((p) => p.peerAsn === 43760);
    expect(inexPeers.every((p) => p.state === 'IDLE' && p.status === 'critical')).toBe(true);
    expect(snap.summary.unhealthyBgpPeers).toBeGreaterThan(0);
  });

  it('eir-near-capacity: 93% → critical status', () => {
    const eir = scenario('eir-near-capacity').interfaces.find((i) => i.deviceId === EDGE1 && i.provider === 'Eir')!;
    expect(eir.utilisationPercent).toBeCloseTo(93, 5);
    expect(eir.status).toBe('critical');
  });

  it('bgp-failure: session Active while interface up', () => {
    const snap = scenario('bgp-failure');
    const peer = snap.bgpPeers.find((p) => p.deviceId === EDGE1 && p.peerAsn === 5466)!;
    expect(peer.state).toBe('ACTIVE');
    expect(peer.established).toBe(false);
    expect(peer.status).toBe('warning');
  });
});

describe('freshness + completeness', () => {
  it('stale scenario → STALE snapshot freshness and a warning', () => {
    const snap = scenario('stale');
    expect(snap.freshness.level).toBe('STALE');
    expect(snap.warnings.join()).toMatch(/stale/i);
  });
  it('partial-response → partial completeness and a missing-device warning', () => {
    const snap = scenario('partial-response');
    expect(snap.summary.deviceCount).toBe(1);
    expect(snap.completeness.level).toBe('partial');
    expect(snap.warnings.join()).toMatch(new RegExp(EDGE2));
  });
});

describe('bandwidth edge cases via scenarios', () => {
  it('counter-reset: rebooted interface is UNAVAILABLE, rolled-over interface is DERIVED', () => {
    const snap = scenario('counter-reset');
    const rebooted = snap.interfaces.find((i) => i.deviceId === EDGE1 && i.name === 'Ethernet4')!;
    const rolled = snap.interfaces.find((i) => i.deviceId === EDGE1 && i.name === 'Ethernet1')!;
    expect(rebooted.bandwidthSource).toBe('UNAVAILABLE');
    expect(rebooted.primaryBps).toBeNull();
    expect(rolled.bandwidthSource).toBe('DERIVED');
    expect(rolled.primaryBps).toBeGreaterThan(0);
  });
  it('missing-speed: utilisation is null with a warning, throughput still reported', () => {
    const itf = scenario('missing-speed').interfaces.find((i) => i.deviceId === EDGE1 && i.name === 'Ethernet3')!;
    expect(itf.speedBps).toBeNull();
    expect(itf.utilisationPercent).toBeNull();
    expect(itf.bandwidthSource).toBe('REPORTED');
    expect(itf.warnings.join()).toMatch(/speed unknown/i);
  });
});

describe('unknown interfaces stay visible', () => {
  it('keeps an unclassifiable interface and counts it', () => {
    const at = new Date(NOW);
    const raw: RawSnapshot = {
      devices: [{ id: 'D1', hostname: 'd1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: at }],
      interfaces: [{ deviceId: 'D1', name: 'Ethernet7', description: 'totally unknown link', adminState: 'up', operState: 'up', speedBps: 10e9, reportedInBps: 1e9, reportedOutBps: 2e9, inOctets: null, outOctets: null, inErrors: 0, outErrors: 0, inDiscards: 0, outDiscards: 0, observedAt: at }],
      bgpPeers: [],
    };
    const snap = buildSnapshot(raw, cfg({ expectedDeviceIds: ['D1'] }));
    expect(snap.interfaces).toHaveLength(1);
    expect(snap.interfaces[0].linkType).toBe('UNKNOWN');
    expect(snap.summary.unknownInterfaceCount).toBe(1);
    expect(snap.warnings.join()).toMatch(/unclassified/i);
  });
});

describe('LAG members are excluded from summary throughput (no double-count)', () => {
  // A Port-Channel bundle plus its member ports. The bundle already carries the members' combined
  // traffic, so the summary must count the bundle only — otherwise Peering/Transit inflate past
  // Total edge and break the invariant Total edge = Peering + Transit.
  const rules: ClassificationRule[] = [
    { match: { kind: 'description_exact', description: 'INEX' }, linkType: 'IX_PEERING', provider: 'INEX' },
    { match: { kind: 'description_exact', description: 'Cogent' }, linkType: 'TRANSIT', provider: 'Cogent' },
  ];
  const at = new Date(NOW);
  const mk = (name: string, description: string, out: number, memberOf: string | null) => ({
    deviceId: 'D1', name, description, adminState: 'up' as const, operState: 'up' as const, speedBps: 100e9,
    reportedInBps: 0, reportedOutBps: out, inOctets: null, outOctets: null, inErrors: 0, outErrors: 0,
    inDiscards: 0, outDiscards: 0, observedAt: at, memberOf,
  });
  const raw: RawSnapshot = {
    devices: [{ id: 'D1', hostname: 'd1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: at }],
    interfaces: [
      // Peering LAG: bundle carries 30G, its two members carry 20G + 10G (= the bundle).
      mk('Port-Channel1', 'INEX', 30e9, null),
      mk('Ethernet1', 'INEX', 20e9, 'Port-Channel1'),
      mk('Ethernet2', 'INEX', 10e9, 'Port-Channel1'),
      // Transit LAG: bundle carries 12G, its two members carry 8G + 4G (= the bundle).
      mk('Port-Channel2', 'Cogent', 12e9, null),
      mk('Ethernet3', 'Cogent', 8e9, 'Port-Channel2'),
      mk('Ethernet4', 'Cogent', 4e9, 'Port-Channel2'),
    ],
    bgpPeers: [],
  };
  const snap = buildSnapshot(raw, cfg({ classificationRules: rules, expectedDeviceIds: ['D1'] }));

  it('Peering counts the bundle only, not its members', () => {
    expect(snap.summary.totalPeeringThroughputBps).toBe(30e9); // not 60G (30 + 20 + 10)
  });
  it('Transit counts the bundle only, not its members', () => {
    expect(snap.summary.totalTransitThroughputBps).toBe(12e9); // not 24G (12 + 8 + 4)
  });
  it('holds the invariant Total edge = Peering + Transit', () => {
    expect(snap.summary.totalEdgeThroughputBps).toBe(42e9);
    expect(snap.summary.totalEdgeThroughputBps).toBe(
      (snap.summary.totalPeeringThroughputBps ?? 0) + (snap.summary.totalTransitThroughputBps ?? 0),
    );
  });
});

describe('normaliseBgpState', () => {
  it('maps known + unknown states', () => {
    expect(normaliseBgpState('Established')).toBe('ESTABLISHED');
    expect(normaliseBgpState('open confirm')).toBe('OPENCONFIRM');
    expect(normaliseBgpState('weird')).toBe('UNKNOWN');
  });
});

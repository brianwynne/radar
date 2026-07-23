// CloudVision adapter: raw → canonical snapshot. Aggregate utilisation is total/total (never
// an average of percentages); classification, freshness, BGP normalisation, completeness and
// warnings are all exercised through the shared scenario fixtures.
import { describe, it, expect } from 'vitest';
import { buildSnapshot, normaliseBgpState, bgpSessionRole, connectionFromLinkType, deviceTypeOf, datacentreOf, type AdapterConfig, type RawSnapshot, type RawInterface } from '../src/cloudvision/adapter.js';
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

describe('LAG capacity is the sum of its member port speeds', () => {
  // A 2×100G Port-Channel whose Sysdb speedMbps under-reports the bundle as a single member (100G).
  // RADAR must derive the bundle's capacity from its members: 200G, not the reported 100G.
  const at = new Date(NOW);
  const mk = (name: string, out: number, speedBps: number | null, operState: 'up' | 'down', memberOf: string | null) => ({
    deviceId: 'D1', name, description: 'CDN-MEM-PKW-6', adminState: 'up' as const, operState, speedBps,
    reportedInBps: 0, reportedOutBps: out, inOctets: null, outOctets: null, inErrors: 0, outErrors: 0,
    inDiscards: 0, outDiscards: 0, observedAt: at, memberOf,
  });
  const build = (interfaces: RawInterface[]) =>
    buildSnapshot({ devices: [{ id: 'D1', hostname: 'd1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: at }], interfaces, bgpPeers: [] },
      cfg({ expectedDeviceIds: ['D1'], warningPercent: 60, criticalPercent: 80 }));

  it('reports 200G for a 2×100G bundle the LAG record under-reported as 100G', () => {
    const snap = build([
      mk('Port-Channel11', 100e9, 100e9, 'up', null), // bundle carries 100G, Arista reports 100G speed
      mk('Ethernet21/1', 60e9, 100e9, 'up', 'Port-Channel11'),
      mk('Ethernet22/1', 40e9, 100e9, 'up', 'Port-Channel11'),
    ]);
    const po = snap.interfaces.find((i) => i.name === 'Port-Channel11')!;
    expect(po.speedBps).toBe(200e9);
    expect(po.utilisationPercent).toBeCloseTo(50); // 100G / 200G
    expect(po.headroomBps).toBe(100e9); // 200G − 100G
  });

  it('counts only UP members toward capacity', () => {
    const snap = build([
      mk('Port-Channel11', 100e9, 100e9, 'up', null),
      mk('Ethernet21/1', 100e9, 100e9, 'up', 'Port-Channel11'),
      mk('Ethernet22/1', 0, 100e9, 'down', 'Port-Channel11'),
    ]);
    expect(snap.interfaces.find((i) => i.name === 'Port-Channel11')!.speedBps).toBe(100e9);
  });

  it('leaves a bundle with no visible members on its reported speed', () => {
    const snap = build([mk('Port-Channel11', 30e9, 100e9, 'up', null)]);
    expect(snap.interfaces.find((i) => i.name === 'Port-Channel11')!.speedBps).toBe(100e9);
  });
});

describe('deviceTypeOf — router vs switch from hostname then model', () => {
  it('classifies the real RTÉ estate (hostname keyword wins, else model family)', () => {
    expect(deviceTypeOf('edge-citywest-router', '7289')).toBe('router');
    expect(deviceTypeOf('edge-parkwest-router', '7289')).toBe('router');
    expect(deviceTypeOf('edge-parkwest-switch', '7289')).toBe('switch'); // hostname beats model
    expect(deviceTypeOf('Orion-Blue-Spine', 'DCS-7280CR3-96')).toBe('switch'); // "spine" keyword
    expect(deviceTypeOf('Orion-Red-Leaf-CAR-1', 'DCS-7020TR-48')).toBe('switch'); // "leaf" keyword
    expect(deviceTypeOf('Orion-Blue-Edge', 'DCS-7020SR-24C2')).toBe('switch'); // no keyword → model
    expect(deviceTypeOf('mystery-box', null)).toBe('unknown');
    expect(deviceTypeOf('router99', '7289')).toBe('router'); // model fallback when hostname is opaque
  });
});

describe('datacentreOf — derived from hostname, null when unknown', () => {
  it('places the edge routers by site and the Orion fabric by plane, else null', () => {
    expect(datacentreOf('edge-citywest-router')).toBe('Citywest');
    expect(datacentreOf('edge-parkwest-router')).toBe('Parkwest');
    expect(datacentreOf('Orion-Blue-Leaf-Lab-1')).toBe('Orion Blue');
    expect(datacentreOf('Orion-Red-Spine')).toBe('Orion Red');
    expect(datacentreOf('some-unnamed-host')).toBeNull();
  });
});

describe('buildSnapshot stamps deviceType + datacentre onto each device', () => {
  const at = new Date(NOW);
  const dev = (id: string, hostname: string, modelName: string | null) => ({ id, hostname, modelName, softwareVersion: null, streaming: true, reachable: true, observedAt: at });
  const snap = buildSnapshot(
    { devices: [dev('D1', 'edge-parkwest-router', '7289'), dev('D2', 'Orion-Red-Spine', 'DCS-7280CR3-96')], interfaces: [], bgpPeers: [] },
    cfg({ expectedDeviceIds: ['D1', 'D2'] }),
  );
  it('derives both fields on the built devices', () => {
    const r = snap.devices.find((d) => d.id === 'D1')!;
    const s = snap.devices.find((d) => d.id === 'D2')!;
    expect(r.deviceType).toBe('router');
    expect(r.datacentre).toBe('Parkwest');
    expect(s.deviceType).toBe('switch');
    expect(s.datacentre).toBe('Orion Red');
  });
});

describe('normaliseBgpState', () => {
  it('maps known + unknown states', () => {
    expect(normaliseBgpState('Established')).toBe('ESTABLISHED');
    expect(normaliseBgpState('open confirm')).toBe('OPENCONFIRM');
    expect(normaliseBgpState('weird')).toBe('UNKNOWN');
  });
});

describe('bgpSessionRole', () => {
  it('route collectors and iBGP are non-delivery; everything external is delivery', () => {
    expect(bgpSessionRole('Route collector')).toBe('route-collector');
    expect(bgpSessionRole('RC')).toBe('route-collector');
    expect(bgpSessionRole('iBGP')).toBe('internal');
    expect(bgpSessionRole('Internal')).toBe('internal');
    // Delivery paths — PNI / INEX / Transit / Peer, or an untagged external session.
    expect(bgpSessionRole('PNI')).toBe('delivery');
    expect(bgpSessionRole('INEX')).toBe('delivery');
    expect(bgpSessionRole('Transit')).toBe('delivery');
    expect(bgpSessionRole('Peer')).toBe('delivery');
    expect(bgpSessionRole(null)).toBe('delivery');
  });

  it('buildSnapshot stamps the role onto each peer (RC excluded downstream)', () => {
    const raw: RawSnapshot = {
      devices: [{ id: 'D1', hostname: 'edge1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: new Date('2026-07-15T12:00:00Z') }],
      interfaces: [],
      bgpPeers: [
        { deviceId: 'D1', peerAddress: '185.6.42.1', peerAsn: 5466, state: 'Established', uptimeSeconds: 10, prefixesReceived: 1, prefixesAdvertised: 1, observedAt: new Date('2026-07-15T12:00:00Z'), connectionType: 'PNI', providerHint: 'Eir' },
        { deviceId: 'D1', peerAddress: '185.6.36.8', peerAsn: 43760, state: 'Established', uptimeSeconds: 10, prefixesReceived: 0, prefixesAdvertised: 0, observedAt: new Date('2026-07-15T12:00:00Z'), connectionType: 'Route collector', providerHint: 'INEX' },
      ],
    };
    const cfg: AdapterConfig = {
      source: 'cloudvision', synthetic: false, now: Date.parse('2026-07-15T12:00:05Z'), staleAfterSeconds: 60,
      expectedDeviceIds: [], classificationRules: DEFAULT_CLASSIFICATION_RULES, providerForAsn: DEFAULT_PROVIDER_FOR_ASN,
      warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound',
    };
    const snap = buildSnapshot(raw, cfg);
    expect(snap.bgpPeers.find((p) => p.peerAsn === 5466)!.role).toBe('delivery');
    expect(snap.bgpPeers.find((p) => p.peerAsn === 43760)!.role).toBe('route-collector');
  });
});

describe('connectionFromLinkType + interface-classification fallback', () => {
  it('maps a classified link type to a human connection label', () => {
    expect(connectionFromLinkType('PRIVATE_PEERING')).toBe('PNI');
    expect(connectionFromLinkType('IX_PEERING')).toBe('INEX');
    expect(connectionFromLinkType('TRANSIT')).toBe('Transit');
    expect(connectionFromLinkType('INTERNAL')).toBe('iBGP');
    expect(connectionFromLinkType('UNKNOWN')).toBeNull(); // never invent a type
  });

  it('a session with no description tag inherits its interface classification (connection + provider + role)', () => {
    const at = new Date('2026-07-15T12:00:00Z');
    const iface = (name: string, description: string) => ({
      deviceId: 'D1', name, description, adminState: 'up' as const, operState: 'up' as const, speedBps: 100e9,
      reportedInBps: 1e9, reportedOutBps: 1e9, inOctets: null, outOctets: null, inErrors: null, outErrors: null,
      inDiscards: null, outDiscards: null, observedAt: at,
    });
    const rules: ClassificationRule[] = [
      { match: { kind: 'device_interface', deviceId: 'D1', interface: 'Port-Channel4' }, linkType: 'PRIVATE_PEERING', provider: 'Sky' },
      { match: { kind: 'device_interface', deviceId: 'D1', interface: 'Ethernet9' }, linkType: 'INTERNAL' },
    ];
    const raw: RawSnapshot = {
      devices: [{ id: 'D1', hostname: 'edge1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: at }],
      interfaces: [iface('Port-Channel4', 'Sky PNI'), iface('Ethernet9', 'to spine')],
      bgpPeers: [
        // No connectionType / description → must be derived from the interface's classification.
        { deviceId: 'D1', peerAddress: '89.207.56.253', peerAsn: 5607, state: 'Established', uptimeSeconds: 10, prefixesReceived: 1, prefixesAdvertised: 1, observedAt: at, interfaceId: 'Port-Channel4' },
        { deviceId: 'D1', peerAddress: '10.0.0.9', peerAsn: 65001, state: 'Established', uptimeSeconds: 10, prefixesReceived: 1, prefixesAdvertised: 1, observedAt: at, interfaceId: 'Ethernet9' },
      ],
    };
    const cfg: AdapterConfig = {
      source: 'cloudvision', synthetic: false, now: Date.parse('2026-07-15T12:00:05Z'), staleAfterSeconds: 60,
      expectedDeviceIds: [], classificationRules: rules, providerForAsn: {}, // deliberately no ASN map
      warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound',
    };
    const snap = buildSnapshot(raw, cfg);
    const sky = snap.bgpPeers.find((p) => p.peerAsn === 5607)!;
    expect(sky.connectionType).toBe('PNI');
    expect(sky.provider).toBe('Sky'); // provider inherited from the interface classification
    expect(sky.role).toBe('delivery');
    const internal = snap.bgpPeers.find((p) => p.peerAsn === 65001)!;
    expect(internal.connectionType).toBe('iBGP');
    expect(internal.role).toBe('internal'); // iBGP inferred → excluded from the delivery view
  });

  it('an explicit description tag still wins over the interface classification', () => {
    const at = new Date('2026-07-15T12:00:00Z');
    const rules: ClassificationRule[] = [
      { match: { kind: 'device_interface', deviceId: 'D1', interface: 'Port-Channel4' }, linkType: 'IX_PEERING' },
    ];
    const raw: RawSnapshot = {
      devices: [{ id: 'D1', hostname: 'edge1', modelName: null, softwareVersion: null, streaming: true, reachable: true, observedAt: at }],
      interfaces: [{
        deviceId: 'D1', name: 'Port-Channel4', description: 'x', adminState: 'up', operState: 'up', speedBps: 100e9,
        reportedInBps: 1e9, reportedOutBps: 1e9, inOctets: null, outOctets: null, inErrors: null, outErrors: null,
        inDiscards: null, outDiscards: null, observedAt: at,
      }],
      bgpPeers: [
        { deviceId: 'D1', peerAddress: '89.207.56.253', peerAsn: 5607, state: 'Established', uptimeSeconds: 10, prefixesReceived: 1, prefixesAdvertised: 1, observedAt: at, interfaceId: 'Port-Channel4', connectionType: 'PNI' },
      ],
    };
    const cfg: AdapterConfig = {
      source: 'cloudvision', synthetic: false, now: Date.parse('2026-07-15T12:00:05Z'), staleAfterSeconds: 60,
      expectedDeviceIds: [], classificationRules: rules, providerForAsn: {}, warningPercent: 80, criticalPercent: 90, primaryDirection: 'outbound',
    };
    const snap = buildSnapshot(raw, cfg);
    expect(snap.bgpPeers[0].connectionType).toBe('PNI'); // description tag, not the interface's INEX
  });
});

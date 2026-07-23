import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import type { ExplainResponse, FilterTrace, Principal, Provenance } from '../api/types';

export const NOC: Principal = {
  subject: 'noc',
  displayName: 'NOC Viewer',
  roles: ['NOC_VIEWER'],
  permissions: ['dashboard.read', 'steering.summary.read', 'topology.summary.read'],
  authenticationMethod: 'dev',
  developmentAuthentication: true,
};
export const VE: Principal = {
  ...NOC,
  displayName: 'Viewing Engineer',
  roles: ['VIEWING_ENGINEER'],
  permissions: [...NOC.permissions, 'dns.explain.read', 'ns1.detail.read', 'ns1.raw.read', 'simulation.run', 'dns.observed.run', 'validation.run', 'snapshot.read', 'audit.read'],
};
export const ENGINEER: Principal = {
  ...VE,
  displayName: 'Engineer',
  roles: ['ENGINEER'],
  permissions: [...VE.permissions, 'snapshot.create', 'topology.manage', 'mapping.manage', 'threshold.manage', 'connector.manage', 'ns1.record.create'],
};

export const PROV: Provenance = {
  source: 'ns1',
  mode: 'mock',
  synthetic: true,
  readOnly: true,
  endpoint: '/v1/zones/rte.ie/live.rte.ie/A',
  retrievedAt: '2026-07-11T10:00:00.000Z',
  disclaimer: 'SYNTHETIC / MOCK NS1 data — not real RTÉ or NS1 configuration.',
};

interface ReqBody {
  zone: string;
  domain: string;
  type: string;
  scenario: { resolverIp: string; ecsPresent: boolean; ecsPrefix?: string; country?: string; asn?: number; healthOverrides?: Record<string, boolean>; loadOverrides?: Record<string, number> };
}

function trace(index: number, type: string, supported: boolean, behaviour: FilterTrace['behaviour'], reason: string, reorder = false, outcomes: FilterTrace['outcomes'] = []): FilterTrace {
  return { index, type, disabled: false, supported, behaviour, config: {}, metadataConsumed: [], input: ['ans-realta', 'ans-fastly'], output: ['ans-realta', 'ans-fastly'], orderingBefore: [], orderingAfter: [], removedAnswerIds: [], outcomes, reorder, reason, confidence: 'high' };
}

/** Build a plausible evaluation response reflecting the request (never hard-coded in the
 *  page — the page renders whatever the API returns). vod.rte.ie yields a partial result. */
export function makeExplain(req: ReqBody): ExplainResponse {
  const asn = req.scenario.asn;
  const ecs = req.scenario.ecsPresent;
  const partial = req.domain === 'vod.rte.ie';
  const realtaDown = req.scenario.healthOverrides?.['ans-realta'] === false;
  const answers = [
    { id: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', rdata: ['192.0.2.10'], weight: 70 },
    { id: 'ans-fastly', label: 'Fastly', deliveryPlatform: 'Fastly', rdata: ['192.0.2.20'], weight: 20 },
  ];
  // shed_load simulation: Réalta has watermarks 70/85, driven by the "*" load override. Absent
  // load = feed-driven, assumed not shedding (steady state).
  const load = req.scenario.loadOverrides?.['*'];
  const LOW = 70, HIGH = 85;
  const shedProb = load === undefined ? undefined : load <= LOW ? 0 : load >= HIGH ? 1 : (load - LOW) / (HIGH - LOW);
  const realtaShed = shedProb === 1;
  const eligible = realtaDown || realtaShed ? ['ans-fastly'] : ['ans-realta', 'ans-fastly'];
  const shedReason = shedProb === undefined ? 'loadavg is feed-driven → assumed not shedding'
    : shedProb >= 1 ? `loadavg ${load} ≥ high watermark 85 → shed (removed)`
      : shedProb > 0 ? `loadavg ${load} between 70–85 → shed on ${Math.round(shedProb * 100)}% of queries`
        : `loadavg ${load} ≤ low watermark 70 → served normally`;
  return {
    provenance: { ...PROV, endpoint: `/v1/zones/${req.zone}/${req.domain}/${req.type}` },
    request: { zone: req.zone, domain: req.domain, type: req.type, scenario: { qname: req.domain, qtype: req.type, ...req.scenario } },
    evaluation: {
      scenario: { qname: req.domain, qtype: req.type, resolverIp: req.scenario.resolverIp, ecsPresent: ecs },
      identity: { source: ecs ? 'ecs' : 'resolver', evaluatedAddress: ecs ? (req.scenario.ecsPrefix ?? '') : req.scenario.resolverIp, country: req.scenario.country, asn, confidence: ecs ? 'high' : 'low', notes: [] },
      answers,
      traces: partial
        ? [trace(0, 'up', true, 'eliminate', 'All up.'), trace(1, 'sticky_shuffle', false, 'unknown', 'Unsupported filter — evaluation stops.')]
        : [
            trace(0, 'up', true, 'eliminate', 'All up.', false, [
              { answerId: 'ans-realta', disposition: 'retained', reason: 'meta.up = true' },
              { answerId: 'ans-fastly', disposition: 'retained', reason: 'no country metadata → kept as a fallback', fallback: true },
            ]),
            trace(1, 'shed_load', true, 'eliminate', `Load shedding (metric=loadavg): ${realtaShed ? '1 removed' : '0 removed'}.`, false, [
              { answerId: 'ans-realta', disposition: realtaShed ? 'removed' : 'retained', reason: shedReason, ...(shedProb !== undefined ? { shedProbability: shedProb } : {}) },
              { answerId: 'ans-fastly', disposition: 'retained', reason: 'no load-shedding watermarks — not subject to shed_load' },
            ]),
            trace(2, 'weighted_shuffle', true, 'reorder', 'Ordered by weight.', true),
          ],
      eligibleAnswerIds: eligible,
      selected: partial ? undefined : eligible[0],
      selectionDeterminism: partial ? 'partial' : 'probabilistic',
      metadataConfigured: ['asn', 'weight'],
      metadataConsumed: partial ? ['up'] : ['up', 'asn', 'weight'],
      expectedDistribution: partial
        ? undefined
        : {
            probabilistic: true,
            method: 'weighted_shuffle',
            shares: eligible.map((id) => {
              const wRe = 70 * (1 - (shedProb ?? 0)), wFa = 20, tot = wRe + wFa;
              const share = id === 'ans-realta' ? wRe / tot : realtaShed ? 1 : wFa / tot;
              return { answerId: id, label: answers.find((a) => a.id === id)!.label, deliveryPlatform: answers.find((a) => a.id === id)!.deliveryPlatform, share };
            }),
            disclaimers: ['Probabilistic, not a guaranteed traffic share. Cloudflare pool selection is separate.'],
          },
      complete: !partial,
      stoppedAtFilterIndex: partial ? 1 : undefined,
      explanation: partial ? 'INCOMPLETE — unsupported filter sticky_shuffle.' : 'Réalta is the most likely delivery platform for this request.',
      warnings: [],
      unsupportedFilters: partial ? ['sticky_shuffle'] : [],
    },
  };
}

export const ZONE_BODY = {
  zone: 'rte.ie',
  records: [
    { domain: 'live.rte.ie', type: 'CNAME', ttl: 300 },
    { domain: 'vod.rte.ie', type: 'CNAME', ttl: 30 },
    { domain: 'edge.rte.ie', type: 'A', ttl: 30 }, // an A record — should be HIDDEN by the CNAME-only filter
  ],
};
export const RECORD_BODY = { id: 'demo', zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', ttl: 30, use_client_subnet: true, answers: [{ id: 'ans-realta', answer: ['192.0.2.10'] }], filters: [{ filter: 'up' }] };
export const RAW_BODY = { ...RECORD_BODY, _radar_note: 'SYNTHETIC / MOCK NS1 data — not real RTÉ or NS1 configuration.' };

export const ACTIVITY_BODY = {
  provenance: PROV,
  mappingNote: 'Field mapping is fixture-derived; unconfirmed NS1 fields appear only under raw.',
  count: 2,
  items: [
    { id: 'act-1', occurredAt: '2026-07-01T09:15:00Z', actor: 'brian@rte.ie', action: 'update', resourceType: 'record', resourceKey: 'live.rte.ie/A', outcome: 'success', detail: 'weight adjusted', raw: { id: 'act-1' } },
    { id: 'act-2', occurredAt: '2026-07-01T08:40:00Z', actor: 'radar-read-only', action: 'view', resourceType: 'zone', resourceKey: 'rte.ie', outcome: 'success', raw: { id: 'act-2' } },
  ],
};

export const SNAPSHOT_SUMMARY = {
  id: '11111111-1111-1111-1111-111111111111',
  sourceSystem: 'ns1',
  resourceKind: 'record',
  resourceKey: 'rte.ie/live.rte.ie/A',
  retrievedAt: '2026-07-01T10:00:00Z',
  createdAt: '2026-07-01T10:00:01Z',
  createdBySubject: 'dev-engineer',
  label: 'before change',
  rawChecksum: 'sha256:aaaaaaaaaaaaaaaa',
  structuralChecksum: 'sha256:bbbbbbbbbbbbbbbb',
  metadata: { mode: 'mock', synthetic: true, warnings: ['mock'] },
};
export const SNAPSHOT_DETAIL = { ...SNAPSHOT_SUMMARY, rawPayload: { domain: 'live.rte.ie' }, canonicalPayload: { domain: 'live.rte.ie' } };
export const SNAPSHOT_HISTORY = {
  count: 2,
  snapshots: [SNAPSHOT_SUMMARY, { ...SNAPSHOT_SUMMARY, id: '22222222-2222-2222-2222-222222222222', label: 'after change', rawChecksum: 'sha256:cccccccccccccccc' }],
};
export const COMPARE_BODY = {
  a: SNAPSHOT_SUMMARY,
  b: { ...SNAPSHOT_SUMMARY, id: '22222222-2222-2222-2222-222222222222' },
  identical: false,
  diffCount: 1,
  diff: [{ path: 'answers[0].meta.weight', kind: 'changed', before: 70, after: 60 }],
};
export const COMPARE_CURRENT_BODY = {
  snapshot: { id: SNAPSHOT_SUMMARY.id, label: 'before change', capturedAt: '2026-07-01T10:00:01Z', retrievedAt: '2026-07-01T10:00:00Z', sourceMode: 'mock', synthetic: true, rawChecksum: 'sha256:aaaa', structuralChecksum: 'sha256:bbbb' },
  current: { retrievedAt: '2026-07-07T15:42:00Z', sourceMode: 'mock', synthetic: true, rawChecksum: 'sha256:cccc', structuralChecksum: 'sha256:dddd' },
  rawChecksumEqual: false,
  structuralChecksumEqual: false,
  identical: false,
  summary: { ttlChanged: true, ecsChanged: false, answersAdded: 0, answersRemoved: 1, answersChanged: 2, filtersAdded: 0, filtersRemoved: 0, filtersChanged: 1, filtersReordered: false, otherChanges: 1 },
  changes: [{ path: 'ttl', kind: 'changed', before: 30, after: 60 }, { path: 'answers[0].meta.weight', kind: 'changed', before: 70, after: 60 }],
  warnings: ['Current record was read in mock mode (synthetic, non-production).'],
  provenance: PROV,
};

export const AUDIT_LIST_BODY = {
  provenance: { source: 'radar', readOnly: true, retrievedAt: '2026-07-07T15:42:00Z' },
  count: 2,
  items: [
    { id: 'e-1', occurredAt: '2026-07-07T15:40:00Z', actorSubject: 'dev-engineer', actorRoles: ['ENGINEER'], authenticationMethod: 'dev', action: 'snapshot.create', resourceType: 'record', resourceKey: 'rte.ie/live.rte.ie/A', outcome: 'success', correlationId: 'corr-1', details: { snapshotId: '11111111-1111-1111-1111-111111111111', rawChecksum: 'sha256:aaaa' } },
    { id: 'e-0', occurredAt: '2026-07-07T15:39:00Z', actorSubject: 'ops@rte.ie', actorRoles: ['ENGINEER'], authenticationMethod: 'oidc', action: 'auth.login', outcome: 'success', correlationId: 'corr-2', details: {} },
  ],
};

export const TELEMETRY_BODY = {
  provenance: { source: 'radar', telemetryMode: 'mock', readOnly: true, informationalOnly: true, notice: 'Network telemetry is currently informational. RADAR is not automatically modifying NS1 steering.', retrievedAt: '2026-07-11T15:42:00Z' },
  count: 4,
  items: [
    { pathId: 'eir-pni', pathName: 'Eir PNI', pathType: 'PNI', status: 'healthy', stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, configuredCapacityBps: 100e9, configuredTargetPercent: 70, observedInboundBps: 18e9, observedOutboundBps: 52e9, observedUtilisationPercent: 52, observedAt: '2026-07-11T15:41:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'MOCK / SYNTHETIC — not production telemetry.' } },
    { pathId: 'virgin-liberty-pni', pathName: 'Virgin / Liberty PNI', pathType: 'PNI', status: 'above_target', stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, configuredCapacityBps: 100e9, configuredTargetPercent: 70, observedInboundBps: 25e9, observedOutboundBps: 74e9, observedUtilisationPercent: 74, observedAt: '2026-07-11T15:41:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'MOCK / SYNTHETIC — not production telemetry.' } },
    { pathId: 'inex', pathName: 'INEX', pathType: 'INEX', status: 'warning', stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, configuredCapacityBps: 40e9, configuredTargetPercent: 70, observedInboundBps: 11e9, observedOutboundBps: 33e9, observedUtilisationPercent: 84, observedAt: '2026-07-11T15:41:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'MOCK / SYNTHETIC — not production telemetry.' } },
    { pathId: 'transit', pathName: 'Transit', pathType: 'transit', status: 'critical', stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, configuredCapacityBps: 20e9, configuredTargetPercent: 70, observedInboundBps: 6e9, observedOutboundBps: 19e9, observedUtilisationPercent: 95, observedAt: '2026-07-11T15:41:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'MOCK / SYNTHETIC — not production telemetry.' } },
  ],
};

const cacheProv = (mode: string) => ({ source: 'radar', telemetryMode: mode, readOnly: true, informationalOnly: true, notice: 'Cache and origin telemetry are informational. RADAR is not automatically modifying NS1 or Cloudflare.', retrievedAt: '2026-07-12T10:00:00Z' });
const poolSample = (id: string, name: string, site: string, status: string, cap: number, out: number, cpu: number) => ({
  poolId: id, poolName: name, site, cacheNodeCount: 2, configuredCapacityBps: cap, observedOutboundBps: out, observedUtilisationPercent: (out / cap) * 100, headroomBps: cap - out, cpuUtilisationPercent: cpu, memoryUtilisationPercent: 60, cacheHitRatio: 0.95, requestRate: 42000, status, stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, observedAt: '2026-07-12T09:59:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'x' },
});
export const CACHE_POOLS_BODY = {
  provenance: cacheProv('mock'), count: 2,
  items: [
    poolSample('donnybrook-1', 'Donnybrook Pool 1', 'Donnybrook', 'healthy', 160e9, 80e9, 55),
    poolSample('external-1', 'External Pool 1', 'External', 'warning', 700e9, 588e9, 85),
  ],
};
export const CACHE_NODES_BODY = {
  provenance: cacheProv('mock'), count: 2,
  items: [
    { nodeId: 'donnybrook-1-n1', nodeName: 'Donnybrook Pool 1 — node 1', poolId: 'donnybrook-1', site: 'Donnybrook', configuredCapacityBps: 80e9, observedOutboundBps: 40e9, observedUtilisationPercent: 50, headroomBps: 40e9, cpuUtilisationPercent: 55, memoryUtilisationPercent: 60, cacheHitRatio: 0.95, requestRate: 21000, status: 'healthy', stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, observedAt: '2026-07-12T09:59:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'x' } },
  ],
};
export const ORIGIN_BODY = {
  provenance: cacheProv('mock'),
  item: { originId: 'origin', originName: 'Réalta origin', requestRate: 9000, outboundBandwidthBps: 120e9, cpuUtilisationPercent: 62, status: 'healthy', stale: false, freshness: { ageSeconds: 3, staleAfterSeconds: 120, fresh: true }, observedAt: '2026-07-12T09:59:57Z', source: 'mock', provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, note: 'x' } },
};

const cvProv = { source: 'radar', telemetryMode: 'mock', readOnly: true, informationalOnly: true, notice: 'Network telemetry is read-only and informational. RADAR issues no device, CloudVision or NS1 writes.', retrievedAt: '2026-07-15T12:00:00Z' };
const cvFresh = { level: 'FRESH', ageSeconds: 4, staleAfterSeconds: 30 };

export const NETWORK_STATUS_BODY = {
  provenance: cvProv,
  status: { enabled: true, running: true, source: 'mock', intervalMs: 10000, lastPollAt: '2026-07-15T12:00:00Z', lastSuccessAt: '2026-07-15T12:00:00Z', lastDurationMs: 12, consecutiveFailures: 0, lastError: null, snapshotAgeSeconds: 4, historyLength: 3, deviceCount: 2, interfaceCount: 3, unknownInterfaceCount: 0 },
  summary: { totalEdgeThroughputBps: 130e9, totalPeeringThroughputBps: 110e9, totalTransitThroughputBps: 20e9, operationalCapacityBps: 300e9, operationalHeadroomBps: 170e9, unhealthyLinks: 1, unhealthyBgpPeers: 1, deviceCount: 2, interfaceCount: 3, unknownInterfaceCount: 0, telemetryAgeSeconds: 4 },
  freshness: cvFresh,
  completeness: { expectedDevices: 2, observedDevices: 2, interfacesWithBandwidth: 3, totalInterfaces: 3, level: 'complete' },
  warnings: [],
  capturedAt: '2026-07-15T12:00:00Z',
};
export const NETWORK_DEVICES_BODY = {
  provenance: cvProv, count: 2,
  items: [
    { id: 'JPE00000001', hostname: 'edge1.dub.rte.ie', modelName: 'DCS-7280SR3', softwareVersion: '4.31.2F', deviceType: 'router', datacentre: 'Citywest', streaming: true, reachable: true, freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock' },
    { id: 'JPE00000002', hostname: 'edge2.dub.rte.ie', modelName: 'DCS-7280SR3', softwareVersion: '4.31.2F', deviceType: 'switch', datacentre: 'Parkwest', streaming: true, reachable: true, freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock' },
  ],
};
const cvItf = (device: string, name: string, desc: string, provider: string, linkType: string, speed: number, out: number, oper: string, status: string, memberOf: string | null = null) => ({
  deviceId: device, deviceHostname: `${device === 'JPE00000001' ? 'edge1' : 'edge2'}.dub.rte.ie`, name, description: desc, provider, location: 'Dublin', linkType, memberOf,
  adminState: 'up', operState: oper, speedBps: speed, inBps: out / 5, outBps: out, primaryBps: oper === 'down' ? 0 : out, primaryDirection: 'outbound', bandwidthSource: 'REPORTED',
  utilisationPercent: oper === 'down' ? 0 : (out / speed) * 100, headroomBps: speed - out, inErrors: 0, outErrors: 0, inDiscards: 0, outDiscards: 0,
  status, freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock', classificationSource: 'description_regex', warnings: [],
});
export const NETWORK_INTERFACES_BODY = {
  provenance: cvProv, count: 7,
  items: [
    cvItf('JPE00000001', 'Port-Channel7', 'INEX LAG', 'INEX', 'IX_PEERING', 200e9, 128e9, 'up', 'healthy'),
    cvItf('JPE00000001', 'Ethernet1', 'Eir PNI Dublin', 'Eir', 'PRIVATE_PEERING', 100e9, 40e9, 'up', 'healthy', 'Port-Channel7'),
    cvItf('JPE00000001', 'Ethernet2', 'INEX IXP Dublin', 'INEX', 'IX_PEERING', 100e9, 88e9, 'up', 'warning'),
    cvItf('JPE00000001', 'Ethernet4', 'Transit Cogent', 'Transit', 'TRANSIT', 100e9, 0, 'down', 'down'),
    // A DIFFERENT router with its OWN Port-Channel7 — members must not merge across devices.
    cvItf('JPE00000002', 'Port-Channel7', 'Transit LAG', 'Transit', 'TRANSIT', 100e9, 30e9, 'up', 'healthy'),
    cvItf('JPE00000002', 'Ethernet9', 'Transit member', 'Transit', 'TRANSIT', 100e9, 30e9, 'up', 'healthy', 'Port-Channel7'),
    // An empty port — no optic ⇒ no capacity reported (speedBps null).
    { deviceId: 'JPE00000001', deviceHostname: 'edge1.dub.rte.ie', name: 'Ethernet50', description: null, provider: null, location: null, linkType: 'UNKNOWN', memberOf: null, adminState: 'unknown', operState: 'unknown', speedBps: null, inBps: null, outBps: null, primaryBps: null, bandwidthSource: 'UNAVAILABLE', utilisationPercent: null, headroomBps: null, inErrors: null, outErrors: null, inDiscards: null, outDiscards: null, status: 'unknown', freshness: cvFresh, observedAt: null, source: 'mock', classificationSource: 'unknown', warnings: [] },
  ],
};
export const NETWORK_LINK_GROUPS_BODY = {
  provenance: cvProv, count: 3,
  items: [
    { key: 'eir', label: 'Eir', linkType: 'PRIVATE_PEERING', capacityBps: 100e9, currentBps: 40e9, utilisationPercent: 40, headroomBps: 60e9, healthyLinks: 1, totalLinks: 1, status: 'healthy', freshness: cvFresh, interfaceIds: ['JPE00000001::Ethernet1'] },
    { key: 'inex', label: 'INEX', linkType: 'IX_PEERING', capacityBps: 100e9, currentBps: 88e9, utilisationPercent: 88, headroomBps: 12e9, healthyLinks: 0, totalLinks: 1, status: 'warning', freshness: cvFresh, interfaceIds: ['JPE00000001::Ethernet2'] },
    { key: 'transit', label: 'Transit', linkType: 'TRANSIT', capacityBps: 0, currentBps: 0, utilisationPercent: null, headroomBps: 0, healthyLinks: 0, totalLinks: 1, status: 'down', freshness: cvFresh, interfaceIds: ['JPE00000001::Ethernet4'] },
  ],
};
export const NETWORK_BGP_BODY = {
  provenance: cvProv, count: 4,
  items: [
    // Eir holds TWO sessions (a dedicated PNI + an INEX bilateral) — they group under one provider.
    { deviceId: 'JPE00000001', deviceHostname: 'edge1.dub.rte.ie', peerAddress: '185.6.36.1', peerAsn: 5466, provider: 'Eir', connectionType: 'Peer', role: 'delivery', description: '[Peer] Eir', state: 'ESTABLISHED', established: true, uptimeSeconds: 864000, prefixesReceived: 850000, prefixesAdvertised: 40, interfaceId: 'Ethernet1', localAddress: '185.6.36.2', routerId: '89.207.56.211', adminShutdown: false, addressFamilies: ['IPv4'], status: 'healthy', freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock' },
    { deviceId: 'JPE00000001', deviceHostname: 'edge1.dub.rte.ie', peerAddress: '185.6.42.1', peerAsn: 5466, provider: 'Eir', connectionType: 'PNI', role: 'delivery', description: '[PNI] Eir', state: 'ESTABLISHED', established: true, uptimeSeconds: 864000, prefixesReceived: 850000, prefixesAdvertised: 40, interfaceId: 'Port-Channel7', localAddress: '185.6.42.2', routerId: '89.207.56.211', adminShutdown: false, addressFamilies: ['IPv4'], status: 'healthy', freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock' },
    { deviceId: 'JPE00000001', deviceHostname: 'edge1.dub.rte.ie', peerAddress: '154.54.1.1', peerAsn: 174, provider: 'Cogent', connectionType: 'Transit', role: 'delivery', description: '[Transit] Cogent', state: 'IDLE', established: false, uptimeSeconds: 0, prefixesReceived: 0, prefixesAdvertised: 40, interfaceId: 'Ethernet8/1/1', localAddress: null, routerId: null, adminShutdown: false, addressFamilies: [], status: 'critical', freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock' },
    // A route-collector session — excluded from the delivery view (surfaced as a hidden-count note).
    { deviceId: 'JPE00000001', deviceHostname: 'edge1.dub.rte.ie', peerAddress: '185.6.36.8', peerAsn: 43760, provider: 'INEX', connectionType: 'Route collector', role: 'route-collector', description: '[RC] INEX route collector', state: 'ESTABLISHED', established: true, uptimeSeconds: 864000, prefixesReceived: 0, prefixesAdvertised: 0, interfaceId: 'Ethernet1', localAddress: '185.6.36.2', routerId: '185.6.36.8', adminShutdown: false, addressFamilies: ['IPv4'], status: 'healthy', freshness: cvFresh, observedAt: '2026-07-15T12:00:00Z', source: 'mock' },
  ],
};
export const RESOLVERS_BODY = {
  provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'Synthetic', retrievedAt: '2026-07-20T22:00:00Z' },
  target: 'live.rte.ie', observedAt: '2026-07-20T22:00:00Z', warnings: [], pollingEnabled: true,
  isps: [
    { isp: 'Eir', asn: 5466, measurementId: 192119190, covered: true, probeCount: 6, resolverCount: 9, ispResolverCount: 8, publicResolverCount: 1, localResolverCount: 1, platforms: { Réalta: 8 }, pools: { '185.54.104': 4, '185.54.105': 5 }, recordName: 'livebase.nsone.rte.ie', edgeName: 'liveedge.rte.ie', vips: ['185.54.104.4', '185.54.105.12'], edgeTtl: { min: 26, max: 30 }, apexTtl: { min: 40, max: 300 }, recordTtl: { min: 40, max: 300 }, steeringImpeded: true, steeringWindowSecs: 300, honoursLowTtl: true, observedAt: '2026-07-20T22:00:00Z', samples: [{ probeId: 27252, resolver: '192.168.1.1', public: false, local: false, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.105.12'], apexTtl: 87, recordTtl: 87, edgeTtl: 26, observedAt: '2026-07-20T22:00:00Z' }, { probeId: 999, resolver: '8.8.8.8', public: true, local: false, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.104.4'], apexTtl: 60, recordTtl: 60, edgeTtl: 30, observedAt: '2026-07-20T22:00:00Z' }, { probeId: 42, resolver: '127.0.0.11', public: false, local: true, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.104.0'], apexTtl: 377, recordTtl: 377, edgeTtl: 300, observedAt: '2026-07-20T22:00:00Z' }] },
    { isp: 'Three', asn: 13280, measurementId: null, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, localResolverCount: 0, platforms: {}, pools: {}, recordName: null, edgeName: null, vips: [], edgeTtl: null, apexTtl: null, recordTtl: null, steeringImpeded: null, steeringWindowSecs: null, honoursLowTtl: null, observedAt: null, samples: [] },
  ],
};
export const NETWORK_HISTORY_BODY = {
  provenance: cvProv, count: 3,
  items: [
    { at: '2026-07-15T11:59:40Z', totalEdgeThroughputBps: 120e9, totalPeeringThroughputBps: 100e9, totalTransitThroughputBps: 20e9, operationalCapacityBps: 300e9, operationalHeadroomBps: 180e9, unhealthyLinks: 0, unhealthyBgpPeers: 0, freshness: 'FRESH' },
    { at: '2026-07-15T11:59:50Z', totalEdgeThroughputBps: 125e9, totalPeeringThroughputBps: 105e9, totalTransitThroughputBps: 20e9, operationalCapacityBps: 300e9, operationalHeadroomBps: 175e9, unhealthyLinks: 1, unhealthyBgpPeers: 0, freshness: 'FRESH' },
    { at: '2026-07-15T12:00:00Z', totalEdgeThroughputBps: 130e9, totalPeeringThroughputBps: 110e9, totalTransitThroughputBps: 20e9, operationalCapacityBps: 300e9, operationalHeadroomBps: 170e9, unhealthyLinks: 1, unhealthyBgpPeers: 1, freshness: 'FRESH' },
  ],
};

const cfProv = { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'MOCK / SYNTHETIC Cloudflare Load Balancing.', retrievedAt: '2026-07-16T12:00:00Z' };
const cfCheck = { type: 'https', method: 'GET', path: '/player/monitoring/alive', expectedCodes: '200', expectedBody: 'OK', intervalSeconds: 60, timeoutSeconds: 5, retries: 2, port: 443, consecutiveUp: 2, consecutiveDown: 3, followRedirects: false, allowInsecure: false };
const cfRegion = (region: string, healthy: boolean, rttMs: number | null) => ({ region, healthy, rttMs, failureReason: healthy ? null : 'connection refused' });
const cfOrigin = (name: string, address: string, healthy: boolean, rttMs: number | null) => ({ name, address, weight: 1, enabled: true, healthy, failureReason: healthy ? null : 'monitor: connection refused', hostHeader: 'origin.rte.ie', rttMs, regionHealth: [cfRegion('WEU', healthy, rttMs), cfRegion('ENAM', healthy, rttMs === null ? null : rttMs + 66)] });
const cfPoolExtra = { originSteeringPolicy: 'least_outstanding_requests', loadShedding: { defaultPercent: 0, defaultPolicy: 'hash', sessionPercent: 0, sessionPolicy: 'hash' }, checkRegions: ['WEU', 'ENAM'], notificationEmail: 'noc@rte.ie' };
export const CLOUDFLARE_POOLS_BODY = {
  provenance: cfProv, count: 2,
  items: [
    { id: 'p-ctw', name: 'live-realta-citywest', description: null, enabled: true, healthy: true, monitorId: 'm1', healthCheck: cfCheck, minimumOrigins: 1, healthyOrigins: 1, totalOrigins: 2, ...cfPoolExtra, origins: [
      cfOrigin('cdn-mem-ctw-1', '185.54.105.0', true, 12),
      cfOrigin('cdn-mem-ctw-2', '185.54.105.4', false, null)] },
    { id: 'p-vod', name: 'vod-edge-caches', description: null, enabled: true, healthy: true, monitorId: 'm2', healthCheck: cfCheck, minimumOrigins: 1, healthyOrigins: 1, totalOrigins: 1, ...cfPoolExtra, origins: [
      cfOrigin('vod-1', '185.54.107.1', true, 9)] },
  ],
};
export const CLOUDFLARE_LBS_BODY = {
  provenance: cfProv, count: 1,
  items: [{ id: 'lb-live', name: 'liveedge.rte.ie', zoneName: 'rte.ie', enabled: true, proxied: false, steeringPolicy: 'random', locationStrategy: 'pop',
    defaultPools: [{ poolId: 'p-ctw', poolName: 'live-realta-citywest', weight: 0.5 }, { poolId: 'p-vod', poolName: 'vod-edge-caches', weight: 0.5 }], fallbackPool: { poolId: 'p-ctw', poolName: 'live-realta-citywest', weight: null }, regionPools: {}, popPools: {}, countryPools: { IE: [{ poolId: 'p-ctw', poolName: 'live-realta-citywest', weight: 0.5 }] },
    sessionAffinity: 'cookie', sessionAffinityTtl: 1800, sessionAffinityAttributes: { samesite: 'Auto', secure: 'Auto', drainDuration: 60, zeroDowntimeFailover: 'sticky' }, adaptiveRoutingFailoverAcrossPools: true, randomSteeringDefaultWeight: 1, ttlSeconds: 30,
    observed: { windowHours: 1, totalRequests: 10480, byPool: [{ key: 'live-realta-citywest', requests: 5281, sharePercent: 50.4 }, { key: 'vod-edge-caches', requests: 5199, sharePercent: 49.6 }], byRegion: [{ key: 'WEU', requests: 10480, sharePercent: 100 }], byColo: [{ key: 'DUB', requests: 10480, sharePercent: 100 }], byOrigin: [{ key: 'cdn-mem-ctw-1', requests: 5281, sharePercent: 50.4 }, { key: 'vod-1', requests: 5199, sharePercent: 49.6 }] } }],
};
export const CLOUDFLARE_STATUS_BODY = {
  status: { enabled: true, running: true, source: 'mock', intervalMs: 60000, lastPollAt: '2026-07-16T12:00:00Z', lastSuccessAt: '2026-07-16T12:00:00Z', lastDurationMs: 5, consecutiveFailures: 0, lastError: null, snapshotAgeSeconds: 3, loadBalancerCount: 1, poolCount: 2 },
  summary: { loadBalancerCount: 1, poolCount: 2, originCount: 3, unhealthyPools: 0, unhealthyOrigins: 1 },
  provenance: cfProv, warnings: [],
};

const fyProv = { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'MOCK / SYNTHETIC Fastly CDN telemetry.', retrievedAt: '2026-07-16T12:00:00Z' };
export const FASTLY_SERVICES_BODY = {
  provenance: fyProv, count: 2,
  items: [
    { serviceId: 'SU-vod', serviceName: 'RTÉ Player VOD', windowSeconds: 600, requests: 5400000, requestsPerSecond: 9000, hits: 4968000, miss: 432000, hitRatioPercent: 92, bandwidthBytes: 2600000000000, bandwidthBps: 34666666666, originFetches: 410000, originOffloadPercent: 92.4, status2xx: 5180000, status3xx: 150000, status4xx: 61000, status5xx: 9000, errorRatePercent: 0.2 },
    { serviceId: 'SU-live', serviceName: 'RTÉ Live', windowSeconds: 600, requests: 2100000, requestsPerSecond: 3500, hits: 1575000, miss: 525000, hitRatioPercent: 75, bandwidthBytes: 1400000000000, bandwidthBps: 18666666666, originFetches: 500000, originOffloadPercent: 76.2, status2xx: 2010000, status3xx: 41000, status4xx: 33000, status5xx: 16000, errorRatePercent: 0.8 },
  ],
};
export const FASTLY_STATUS_BODY = {
  status: { enabled: true, running: true, source: 'mock', intervalMs: 60000, lastPollAt: '2026-07-16T12:00:00Z', lastSuccessAt: '2026-07-16T12:00:00Z', lastDurationMs: 5, consecutiveFailures: 0, lastError: null, snapshotAgeSeconds: 3, serviceCount: 2 },
  realtime: { enabled: true, running: true, source: 'fastly', windowSeconds: 120, services: [{ serviceId: 'SU-live', serviceName: 'RTÉ Live', running: true, sampleCount: 3, lastSampleAt: '2026-07-16T12:00:02Z', lastPollAt: '2026-07-16T12:00:02Z', consecutiveFailures: 0, lastError: null }] },
  summary: { serviceCount: 2, totalRequestsPerSecond: 12500, totalBandwidthBps: 53333333332, avgHitRatioPercent: 87.3 },
  provenance: fyProv, warnings: [],
};
// Real-time live-tail: the busiest service (SU-vod, default-selected) streams per-second samples;
// the other (SU-live) is idle (empty → nulls, shown honestly, never fabricated).
export const FASTLY_REALTIME_BODY = {
  provenance: fyProv, source: 'fastly', windowSeconds: 120,
  series: [
    { serviceId: 'SU-vod', serviceName: 'RTÉ Player VOD', latestRequestsPerSecond: 588, latestBandwidthBps: 4967576688, lastSampleAt: '2026-07-16T12:00:02Z', samples: [
      { second: 1784227200, at: '2026-07-16T12:00:00Z', requests: 710, hits: 554, miss: 137, errors: 19, bandwidthBytes: 720006896, status2xx: 685, status3xx: 0, status4xx: 25, status5xx: 0, statusCodes: { '200': 650, '206': 35, '404': 25 } },
      { second: 1784227201, at: '2026-07-16T12:00:01Z', requests: 745, hits: 623, miss: 113, errors: 9, bandwidthBytes: 757781453, status2xx: 736, status3xx: 0, status4xx: 9, status5xx: 0, statusCodes: { '200': 700, '206': 36, '404': 9 } },
      { second: 1784227202, at: '2026-07-16T12:00:02Z', requests: 588, hits: 464, miss: 113, errors: 11, bandwidthBytes: 620947086, status2xx: 573, status3xx: 0, status4xx: 15, status5xx: 0, statusCodes: { '200': 540, '206': 33, '404': 15 } },
    ] },
    { serviceId: 'SU-live', serviceName: 'RTÉ Live', latestRequestsPerSecond: null, latestBandwidthBps: null, lastSampleAt: null, samples: [] },
  ],
  warnings: [],
};

// Akamai realtime (DataStream 2 aggregated): one CP code streaming per-second telemetry.
const akProv = { source: 'akamai', synthetic: false, readOnly: true, informationalOnly: true, notice: 'Akamai DataStream 2 telemetry — read-only and informational.', retrievedAt: '2026-07-16T21:00:02Z' };
export const AKAMAI_REALTIME_BODY = {
  provenance: akProv, source: 'akamai', windowSeconds: 300,
  series: [
    { serviceId: '1629049', serviceName: 'LIVE.RTE.IE', latestRequestsPerSecond: 315, latestBandwidthBps: 1_120_000_000, lastSampleAt: '2026-07-16T21:00:02Z', samples: [
      { second: 1784235600, at: '2026-07-16T21:00:00Z', requests: 300, hits: 240, miss: 60, bandwidthBytes: 140_000_000, status2xx: 250, status3xx: 20, status4xx: 20, status5xx: 10, statusCodes: { '200': 230, '206': 20, '304': 20, '404': 20, '500': 10 } },
      { second: 1784235602, at: '2026-07-16T21:00:02Z', requests: 315, hits: 255, miss: 60, bandwidthBytes: 140_000_000, status2xx: 265, status3xx: 20, status4xx: 20, status5xx: 10, statusCodes: { '200': 245, '206': 20, '304': 20, '404': 20, '500': 10 } },
    ] },
  ],
  warnings: [],
};

const defaultConnection = { connector: 'cloudvision', enabled: true, mode: 'live', endpoint: 'https://cvp.test', verifyTls: true, edgeDeviceIds: ['DEV1'], tokenConfigured: true, tokenSetAt: '2026-07-15T10:00:00Z', updatedBy: 'eng@rte.ie', updatedAt: '2026-07-15T10:00:00Z', source: 'database', masterKeyAvailable: true, degraded: null };
let connectionState: Record<string, unknown> = { ...defaultConnection };

const defaultCloudflareConnection = { connector: 'cloudflare', enabled: true, mode: 'live', accountId: '0dae703e9ae3c6b11a561818549a4192', zones: ['rte.ie'], tokenConfigured: true, tokenSetAt: '2026-07-15T10:00:00Z', updatedBy: 'eng@rte.ie', updatedAt: '2026-07-15T10:00:00Z', source: 'database', masterKeyAvailable: true, degraded: null };
let cloudflareConnectionState: Record<string, unknown> = { ...defaultCloudflareConnection };

const defaultFastlyConnection = { connector: 'fastly', enabled: true, mode: 'live', apiBase: 'https://api.fastly.com', serviceIds: ['SU-vod'], tokenConfigured: true, tokenSetAt: '2026-07-15T10:00:00Z', updatedBy: 'eng@rte.ie', updatedAt: '2026-07-15T10:00:00Z', source: 'database', masterKeyAvailable: true, degraded: null };
let fastlyConnectionState: Record<string, unknown> = { ...defaultFastlyConnection };

const defaultAkamaiConnection = { connector: 'akamai', enabled: false, cpCodes: [] as string[], cpNames: {} as Record<string, string>, s3: { bucket: '', region: 'us-east-1', prefix: '', accessKeyId: '', pollIntervalSeconds: 30 }, windowSeconds: 300, secretConfigured: false, secretSetAt: null, updatedBy: null, updatedAt: null, source: 'environment', masterKeyAvailable: true, connected: false, degraded: null };
let akamaiConnectionState: Record<string, unknown> = { ...defaultAkamaiConnection };

const defaultNs1Connection = { connector: 'ns1', mode: 'mock', apiBase: 'https://api.nsone.net/v1', keyConfigured: false, keySetAt: null, updatedBy: null, updatedAt: null, source: 'environment', live: false, masterKeyAvailable: true, degraded: null, writeEnabled: false, writeAllow: ['livetest.rte.ie', '*.livetest.rte.ie'], writeKeyConfigured: false, writeKeySetAt: null, writeLive: false };
let ns1ConnectionState: Record<string, unknown> = { ...defaultNs1Connection };

export function stubApi(principal: Principal, overrides: { bgpBody?: unknown } = {}): void {
  connectionState = { ...defaultConnection };
  cloudflareConnectionState = { ...defaultCloudflareConnection };
  fastlyConnectionState = { ...defaultFastlyConnection };
  akamaiConnectionState = { ...defaultAkamaiConnection };
  ns1ConnectionState = { ...defaultNs1Connection };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = String(input).split('?')[0];
      let status = 200;
      let body: unknown = {};
      if (p.endsWith('/api/v1/me')) body = principal;
      else if (p.endsWith('/telemetry/network-paths')) body = TELEMETRY_BODY;
      else if (p.endsWith('/telemetry/cache-pools')) body = CACHE_POOLS_BODY;
      else if (p.endsWith('/telemetry/cache-nodes')) body = CACHE_NODES_BODY;
      else if (p.endsWith('/telemetry/origin')) body = ORIGIN_BODY;
      else if (p.endsWith('/network/status')) body = NETWORK_STATUS_BODY;
      else if (p.endsWith('/network/devices')) body = NETWORK_DEVICES_BODY;
      else if (p.endsWith('/network/interfaces')) body = NETWORK_INTERFACES_BODY;
      else if (p.endsWith('/network/link-groups')) body = NETWORK_LINK_GROUPS_BODY;
      else if (p.endsWith('/network/resolvers/check/results')) body = { snapshot: RESOLVERS_BODY, pending: false };
      else if (p.endsWith('/network/resolvers/check')) body = { checks: [{ isp: 'Eir', asn: 5466, measurementId: 900001 }], startedAt: '2026-07-20T22:00:00Z' };
      else if (p.endsWith('/network/resolvers/polling')) body = { pollingEnabled: JSON.parse(String(init?.body ?? '{}')).enabled ?? true };
      else if (p.endsWith('/network/resolvers')) body = RESOLVERS_BODY;
      else if (p.endsWith('/network/bgp-peers')) body = overrides.bgpBody ?? NETWORK_BGP_BODY;
      else if (p.endsWith('/network/history')) body = NETWORK_HISTORY_BODY;
      else if (p.endsWith('/network/cloudflare/status')) body = CLOUDFLARE_STATUS_BODY;
      else if (p.endsWith('/network/cloudflare/load-balancers')) body = CLOUDFLARE_LBS_BODY;
      else if (p.endsWith('/network/cloudflare/pools/refresh')) {
        // Fast tier: return a distinct RTT (99 ms) so tests can prove the overlay replaces the slow value.
        const ids = (new URLSearchParams(String(input).split('?')[1] ?? '').get('ids') ?? '').split(',').filter(Boolean);
        const pools = CLOUDFLARE_POOLS_BODY.items.filter((pl) => ids.includes(pl.id)).map((pl) => ({ id: pl.id, origins: pl.origins.map((o) => ({ address: o.address, healthy: o.healthy, rttMs: o.rttMs === null ? null : 99, regionHealth: o.regionHealth })) }));
        body = { provenance: cfProv, pools, capped: false, max: 8 };
      }
      else if (p.endsWith('/network/cloudflare/pools')) body = CLOUDFLARE_POOLS_BODY;
      else if (p.endsWith('/cdn/fastly/status')) body = FASTLY_STATUS_BODY;
      else if (p.endsWith('/cdn/fastly/services')) body = FASTLY_SERVICES_BODY;
      else if (p.endsWith('/cdn/fastly/realtime')) body = FASTLY_REALTIME_BODY;
      else if (p.endsWith('/cdn/akamai/realtime')) body = AKAMAI_REALTIME_BODY;
      else if (p.endsWith('/cdn/fastly/connection/test')) body = { result: { ok: true, source: 'fastly', summary: { services: 3 } } };
      else if (p.endsWith('/cdn/fastly/connection')) {
        if (init?.method === 'PUT') {
          const b = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          fastlyConnectionState = {
            ...fastlyConnectionState,
            enabled: b.enabled ?? fastlyConnectionState.enabled,
            mode: b.mode ?? fastlyConnectionState.mode,
            apiBase: b.apiBase !== undefined ? b.apiBase : fastlyConnectionState.apiBase,
            serviceIds: b.serviceIds ?? fastlyConnectionState.serviceIds,
            tokenConfigured: b.clearToken ? false : b.token ? true : fastlyConnectionState.tokenConfigured,
          };
        }
        body = { settings: fastlyConnectionState };
      }
      else if (p.endsWith('/ns1/connection/test')) body = { result: { ok: true, source: 'ns1', summary: { zones: 12 } } };
      else if (p.endsWith('/ns1/connection')) {
        if (init?.method === 'PUT') {
          const b = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          const mode = (b.mode ?? ns1ConnectionState.mode) as string;
          const keyConfigured = b.clearKey ? false : b.key ? true : (ns1ConnectionState.keyConfigured as boolean);
          const writeKeyConfigured = b.clearWriteKey ? false : b.writeKey ? true : (ns1ConnectionState.writeKeyConfigured as boolean);
          ns1ConnectionState = { ...ns1ConnectionState, mode, apiBase: b.apiBase !== undefined ? b.apiBase : ns1ConnectionState.apiBase, keyConfigured, writeKeyConfigured, live: mode === 'live' && keyConfigured, source: 'database' };
        }
        body = { settings: ns1ConnectionState };
      }
      else if (p.endsWith('/cdn/akamai/connection/test')) body = { result: { ok: true, source: 'akamai', summary: { objects: 5 } } };
      else if (p.endsWith('/cdn/akamai/connection')) {
        if (init?.method === 'PUT') {
          const b = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          const s3 = akamaiConnectionState.s3 as Record<string, unknown>;
          akamaiConnectionState = {
            ...akamaiConnectionState,
            enabled: b.enabled ?? akamaiConnectionState.enabled,
            cpCodes: b.cpCodes ?? akamaiConnectionState.cpCodes,
            cpNames: b.cpNames ?? akamaiConnectionState.cpNames,
            s3: { ...s3, bucket: b.bucket !== undefined ? b.bucket : s3.bucket, region: b.region !== undefined ? b.region : s3.region, prefix: b.prefix !== undefined ? b.prefix : s3.prefix, accessKeyId: b.accessKeyId !== undefined ? b.accessKeyId : s3.accessKeyId, pollIntervalSeconds: b.pollIntervalSeconds ?? s3.pollIntervalSeconds },
            secretConfigured: b.clearSecret ? false : b.secretKey ? true : akamaiConnectionState.secretConfigured,
            source: 'database',
          };
        }
        body = { settings: akamaiConnectionState };
      }
      else if (p.endsWith('/network/cloudflare/connection/test')) body = { result: { ok: true, source: 'cloudflare', summary: { loadBalancers: 2, pools: 3, origins: 6 } } };
      else if (p.endsWith('/network/cloudflare/connection')) {
        if (init?.method === 'PUT') {
          const b = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          cloudflareConnectionState = {
            ...cloudflareConnectionState,
            enabled: b.enabled ?? cloudflareConnectionState.enabled,
            mode: b.mode ?? cloudflareConnectionState.mode,
            accountId: b.accountId !== undefined ? b.accountId : cloudflareConnectionState.accountId,
            zones: b.zones ?? cloudflareConnectionState.zones,
            tokenConfigured: b.clearToken ? false : b.token ? true : cloudflareConnectionState.tokenConfigured,
          };
        }
        body = { settings: cloudflareConnectionState };
      }
      else if (p.endsWith('/network/connection/test')) body = { result: { ok: true, source: 'cloudvision', summary: { devices: 2, interfaces: 8, bgpPeers: 5, freshness: 'FRESH' } } };
      else if (p.endsWith('/network/connection')) {
        if (init?.method === 'PUT') {
          const b = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          connectionState = {
            ...connectionState,
            enabled: b.enabled ?? connectionState.enabled,
            mode: b.mode ?? connectionState.mode,
            endpoint: b.endpoint !== undefined ? b.endpoint : connectionState.endpoint,
            verifyTls: b.verifyTls ?? connectionState.verifyTls,
            edgeDeviceIds: b.edgeDeviceIds ?? connectionState.edgeDeviceIds,
            tokenConfigured: b.clearToken ? false : b.token ? true : connectionState.tokenConfigured,
          };
        }
        body = { settings: connectionState };
      }
      else if (p.endsWith('/ns1/config')) body = { mode: 'mock', synthetic: true, readOnly: true, disclaimer: 'SYNTHETIC / MOCK' };
      else if (p.endsWith('/ns1/records/write-enabled')) { const b = JSON.parse(String(init?.body ?? '{}')) as { enabled?: boolean }; body = { writeEnabled: !!b.enabled, writeReady: !!b.enabled, allowList: ['livetest.rte.ie', '*.livetest.rte.ie'] }; }
      else if (p.endsWith('/ns1/records/capability')) body = { writeEnabled: false, writeReady: false, allowList: ['livetest.rte.ie', '*.livetest.rte.ie'] };
      else if (p.endsWith('/ns1/records/clone/plan') || p.endsWith('/ns1/records/plan')) body = { allowed: true, blockedReason: null, target: { zone: 'livetest.rte.ie', domain: 'livetest.rte.ie', type: 'A' }, request: { method: 'PUT', path: '/zones/livetest.rte.ie/livetest.rte.ie/A', body: {} }, warnings: [] };
      else if (p.endsWith('/ns1/records/clone/apply') || p.endsWith('/ns1/records/apply')) body = { created: true, provenance: { source: 'ns1', readOnly: false, write: true, notice: 'Created.', appliedAt: '2026-07-21T00:00:00Z' }, record: { id: 'r1' } };
      else if (p.endsWith('/ns1/active-record')) body = { provenance: PROV, entry: 'live.rte.ie', target: 'live.rte.ie', active: { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A' }, filterCount: 2, warnings: [] };
      else if (p.includes('/dns/explain')) body = makeExplain(JSON.parse(String(init?.body)) as ReqBody);
      else if (p.endsWith('/ns1/activity')) body = ACTIVITY_BODY;
      else if (p.endsWith('/api/v1/audit')) body = AUDIT_LIST_BODY;
      else if (p.endsWith('/api/v1/snapshots')) body = { count: 2, snapshots: SNAPSHOT_HISTORY.snapshots };
      else if (p.endsWith('/snapshots/compare')) body = COMPARE_BODY;
      else if (p.endsWith('/compare-current')) body = COMPARE_CURRENT_BODY;
      else if (/\/ns1\/zones\/[^/]+\/[^/]+\/[^/]+\/snapshots$/.test(p)) {
        if (init?.method === 'POST') {
          status = 201;
          body = { provenance: PROV, snapshot: SNAPSHOT_DETAIL };
        } else body = SNAPSHOT_HISTORY;
      } else if (/\/api\/v1\/snapshots\/[^/]+$/.test(p)) body = { snapshot: SNAPSHOT_DETAIL };
      else if (/\/ns1\/zones\/[^/]+\/[^/]+\/[^/]+\/raw$/.test(p)) body = { provenance: PROV, raw: RAW_BODY };
      else if (/\/ns1\/zones\/[^/]+\/[^/]+\/[^/]+$/.test(p)) body = { provenance: PROV, record: RECORD_BODY };
      else if (/\/ns1\/zones\/[^/]+$/.test(p)) body = { provenance: PROV, zone: ZONE_BODY };
      else if (p.endsWith('/ns1/zones')) body = { provenance: PROV, zones: [{ zone: 'rte.ie' }] };
      else status = 404;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

export const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );

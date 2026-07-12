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
  permissions: [...NOC.permissions, 'dns.explain.read', 'ns1.detail.read', 'ns1.raw.read', 'simulation.run', 'snapshot.read', 'audit.read'],
};
export const ENGINEER: Principal = {
  ...VE,
  displayName: 'Engineer',
  roles: ['ENGINEER'],
  permissions: [...VE.permissions, 'snapshot.create', 'topology.manage', 'mapping.manage', 'threshold.manage'],
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
  scenario: { resolverIp: string; ecsPresent: boolean; ecsPrefix?: string; country?: string; asn?: number; healthOverrides?: Record<string, boolean> };
}

function trace(index: number, type: string, supported: boolean, behaviour: FilterTrace['behaviour'], reason: string, reorder = false): FilterTrace {
  return { index, type, disabled: false, supported, behaviour, config: {}, metadataConsumed: [], input: ['ans-realta', 'ans-fastly'], output: ['ans-realta', 'ans-fastly'], orderingBefore: [], orderingAfter: [], removedAnswerIds: [], outcomes: [], reorder, reason, confidence: 'high' };
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
  const eligible = realtaDown ? ['ans-fastly'] : ['ans-realta', 'ans-fastly'];
  return {
    provenance: { ...PROV, endpoint: `/v1/zones/${req.zone}/${req.domain}/${req.type}` },
    request: { zone: req.zone, domain: req.domain, type: req.type, scenario: { qname: req.domain, qtype: req.type, ...req.scenario } },
    evaluation: {
      scenario: { qname: req.domain, qtype: req.type, resolverIp: req.scenario.resolverIp, ecsPresent: ecs },
      identity: { source: ecs ? 'ecs' : 'resolver', evaluatedAddress: ecs ? (req.scenario.ecsPrefix ?? '') : req.scenario.resolverIp, country: req.scenario.country, asn, confidence: ecs ? 'high' : 'low', notes: [] },
      answers,
      traces: partial
        ? [trace(0, 'up', true, 'eliminate', 'All up.'), trace(1, 'shed_load', false, 'unknown', 'Unsupported filter — evaluation stops.')]
        : [trace(0, 'up', true, 'eliminate', 'All up.'), trace(1, 'weighted_shuffle', true, 'reorder', 'Ordered by weight.', true)],
      eligibleAnswerIds: eligible,
      selected: partial ? undefined : eligible[0],
      expectedDistribution: partial
        ? undefined
        : {
            probabilistic: true,
            method: 'weighted_shuffle',
            shares: eligible.map((id) => ({ answerId: id, label: answers.find((a) => a.id === id)!.label, deliveryPlatform: answers.find((a) => a.id === id)!.deliveryPlatform, share: id === 'ans-realta' ? 0.78 : 0.22 })),
            disclaimers: ['Probabilistic, not a guaranteed traffic share. Cloudflare pool selection is separate.'],
          },
      complete: !partial,
      stoppedAtFilterIndex: partial ? 1 : undefined,
      explanation: partial ? 'INCOMPLETE — unsupported filter shed_load.' : 'Réalta is the most likely delivery platform for this request.',
      warnings: [],
      unsupportedFilters: partial ? ['shed_load'] : [],
    },
  };
}

export const ZONE_BODY = {
  zone: 'rte.ie',
  records: [
    { domain: 'live.rte.ie', type: 'A' },
    { domain: 'vod.rte.ie', type: 'A' },
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

export function stubApi(principal: Principal): void {
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
      else if (p.endsWith('/ns1/config')) body = { mode: 'mock', synthetic: true, readOnly: true, disclaimer: 'SYNTHETIC / MOCK' };
      else if (p.includes('/dns/explain')) body = makeExplain(JSON.parse(String(init?.body)) as ReqBody);
      else if (p.endsWith('/ns1/activity')) body = ACTIVITY_BODY;
      else if (p.endsWith('/api/v1/audit')) body = AUDIT_LIST_BODY;
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

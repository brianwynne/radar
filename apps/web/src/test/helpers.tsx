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

export function stubApi(principal: Principal): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      let body: unknown = {};
      if (path.includes('/api/v1/me')) body = principal;
      else if (path.includes('/api/v1/ns1/config')) body = { mode: 'mock', synthetic: true, readOnly: true, disclaimer: 'SYNTHETIC / MOCK' };
      else if (path.includes('/api/v1/dns/explain')) body = makeExplain(JSON.parse(String(init?.body)) as ReqBody);
      else if (path.includes('/api/v1/ns1/zones')) body = { provenance: PROV, zones: [{ zone: 'rte.ie' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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

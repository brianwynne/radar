import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import type { ExplainResponse, Principal } from '../api/types';

const VE: Principal = {
  subject: 'dev-engineer',
  displayName: 'Dev Engineer',
  roles: ['VIEWING_ENGINEER'],
  permissions: [
    'dashboard.read',
    'steering.summary.read',
    'topology.summary.read',
    'dns.explain.read',
    'ns1.detail.read',
    'ns1.raw.read',
    'simulation.run',
  ],
  authenticationMethod: 'dev',
  developmentAuthentication: true,
};
const NOC: Principal = {
  ...VE,
  roles: ['NOC_VIEWER'],
  permissions: ['dashboard.read', 'steering.summary.read', 'topology.summary.read'],
};

const EXPLAIN: ExplainResponse = {
  provenance: {
    source: 'ns1',
    mode: 'mock',
    synthetic: true,
    readOnly: true,
    endpoint: '/v1/zones/rte.ie/live.rte.ie/A',
    retrievedAt: '2026-07-11T10:00:00.000Z',
    disclaimer: 'SYNTHETIC / MOCK NS1 data — not real RTÉ or NS1 configuration.',
  },
  request: {
    zone: 'rte.ie',
    domain: 'live.rte.ie',
    type: 'A',
    scenario: { qname: 'live.rte.ie', qtype: 'A', resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: 5466 },
  },
  evaluation: {
    scenario: { qname: 'live.rte.ie', qtype: 'A', resolverIp: '9.9.9.9', ecsPresent: true },
    identity: { source: 'ecs', evaluatedAddress: '185.2.100.0/24', country: 'IE', asn: 5466, confidence: 'high', notes: ['ECS honoured.'] },
    answers: [
      { id: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', rdata: ['192.0.2.10'], weight: 70 },
      { id: 'ans-fastly', label: 'Fastly', deliveryPlatform: 'Fastly', rdata: ['192.0.2.20'], weight: 20 },
    ],
    traces: [
      { index: 0, type: 'up', disabled: false, supported: true, behaviour: 'eliminate', config: {}, metadataConsumed: ['up'], input: ['ans-realta', 'ans-fastly'], output: ['ans-realta', 'ans-fastly'], orderingBefore: [], orderingAfter: [], removedAnswerIds: [], outcomes: [], reorder: false, reason: 'All answers are up.', confidence: 'high' },
      { index: 1, type: 'weighted_shuffle', disabled: false, supported: true, behaviour: 'reorder', config: {}, metadataConsumed: ['weight'], input: ['ans-realta', 'ans-fastly'], output: ['ans-realta', 'ans-fastly'], orderingBefore: [], orderingAfter: [], removedAnswerIds: [], outcomes: [], reorder: true, reason: 'Ordered by weight.', confidence: 'high' },
    ],
    eligibleAnswerIds: ['ans-realta', 'ans-fastly'],
    selected: 'ans-realta',
    expectedDistribution: {
      probabilistic: true,
      method: 'weighted_shuffle',
      shares: [
        { answerId: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', share: 0.78 },
        { answerId: 'ans-fastly', label: 'Fastly', deliveryPlatform: 'Fastly', share: 0.22 },
      ],
      disclaimers: ['Probabilistic, not a guaranteed traffic share.'],
    },
    complete: true,
    explanation: 'Réalta is the most likely delivery platform for this request.',
    warnings: [],
    unsupportedFilters: [],
  },
};

function stubApi(principal: Principal): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.includes('/api/v1/me')
        ? principal
        : path.includes('/api/v1/ns1/config')
          ? { mode: 'mock', synthetic: true, readOnly: true, disclaimer: 'SYNTHETIC / MOCK' }
          : path.includes('/api/v1/dns/explain')
            ? EXPLAIN
            : path.includes('/api/v1/ns1/zones')
              ? { provenance: EXPLAIN.provenance, zones: [{ zone: 'rte.ie' }] }
              : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('mock/synthetic disclosure', () => {
  it('suppresses the global MOCK MODE banner (synthetic data is disclosed per-view instead)', async () => {
    stubApi(VE);
    renderAt('/');
    await screen.findByRole('link', { name: 'Network Telemetry' }); // app shell rendered + effects settled
    expect(screen.queryByText(/MOCK MODE — data is SYNTHETIC/i)).not.toBeInTheDocument();
  });
});

describe('RBAC-aware navigation (cosmetic; API still enforces)', () => {
  it('hides Explain/Explorer from a NOC viewer and shows them to a Viewing Engineer', async () => {
    stubApi(NOC);
    const noc = renderAt('/');
    await screen.findByText(/NOC Overview/i);
    expect(screen.queryByRole('link', { name: 'Explain' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'NS1 Explorer' })).toBeNull();
    noc.unmount();

    stubApi(VE);
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Explain' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'NS1 Explorer' })).toBeInTheDocument();
  });
});

describe('Explain DNS workflow', () => {
  it('submits a scenario and renders the graphical evaluation, distribution and disclaimers', async () => {
    stubApi(VE);
    renderAt('/explain');
    const button = await screen.findByRole('button', { name: /Explain decision/i });
    await userEvent.click(button);

    expect(await screen.findByText(/Réalta is the most likely delivery platform/i)).toBeInTheDocument();
    // Filter Chain steps rendered
    expect(screen.getByText('weighted_shuffle')).toBeInTheDocument();
    // Expected probabilistic distribution
    expect(screen.getByText('78%')).toBeInTheDocument();
    expect(screen.getByText(/Probabilistic, not a guaranteed traffic share/i)).toBeInTheDocument();
    // Synthetic provenance disclosed on the result
    expect(screen.getAllByText(/SYNTHETIC/i).length).toBeGreaterThan(0);
    // Réalta/Cloudflare framing
    expect(screen.getByText(/NS1 selects the delivery platform/i)).toBeInTheDocument();
  });
});

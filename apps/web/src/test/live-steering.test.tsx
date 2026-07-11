import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOC, VE, renderAt } from './helpers';
import type { ExplainResponse, FilterTrace } from '../api/types';

afterEach(() => vi.unstubAllGlobals());

const ANSWERS = [
  { id: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', rdata: ['192.0.2.10'], weight: 70 },
  { id: 'ans-fastly', label: 'Fastly', deliveryPlatform: 'Fastly', rdata: ['192.0.2.20'], weight: 30 },
];
const trace = (index: number, type: string, reorder = false): FilterTrace => ({ index, type, disabled: false, supported: true, behaviour: reorder ? 'reorder' : 'eliminate', config: {}, metadataConsumed: [], input: [], output: [], orderingBefore: [], orderingAfter: [], removedAnswerIds: [], outcomes: [], reorder, reason: 'ok', confidence: 'high' });

interface Opts {
  eligible?: string[];
  selected?: string;
}
function buildExplain(req: { zone: string; domain: string; type: string; scenario: { ecsPrefix?: string; country?: string; asn?: number; resolverIp: string; ecsPresent: boolean } }, o: Opts = {}): ExplainResponse {
  const eligible = o.eligible ?? ['ans-realta', 'ans-fastly'];
  const shares = eligible.map((id) => ({ answerId: id, label: ANSWERS.find((a) => a.id === id)!.label, deliveryPlatform: ANSWERS.find((a) => a.id === id)!.deliveryPlatform, share: id === 'ans-realta' ? 0.7 : 0.3 }));
  return {
    provenance: { source: 'ns1', mode: 'mock', synthetic: true, readOnly: true, endpoint: '/v1/zones/rte.ie/live.rte.ie/A', retrievedAt: '2026-07-07T15:42:00Z', disclaimer: 'MOCK' },
    request: { zone: req.zone, domain: req.domain, type: req.type, scenario: { qname: req.domain, qtype: req.type, ...req.scenario } },
    evaluation: {
      scenario: { qname: req.domain, qtype: req.type, resolverIp: req.scenario.resolverIp, ecsPresent: true },
      identity: { source: 'ecs', evaluatedAddress: req.scenario.ecsPrefix ?? '', country: req.scenario.country, asn: req.scenario.asn, confidence: 'high', notes: [] },
      answers: ANSWERS,
      traces: [trace(0, 'up'), trace(1, 'weighted_shuffle', true)],
      eligibleAnswerIds: eligible,
      selected: o.selected ?? eligible[0],
      expectedDistribution: { probabilistic: true, method: 'weighted_shuffle', shares, disclaimers: ['probabilistic'] },
      complete: true,
      explanation: 'ok',
      warnings: [],
      unsupportedFilters: [],
    },
  };
}

function stub(principal: typeof VE, explain: (asn: number, callForAsn: number) => Opts) {
  const perAsn = new Map<number, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = String(input).split('?')[0];
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/api/v1/me')) return j(principal);
      if (p.endsWith('/ns1/config')) return j({ mode: 'mock', synthetic: true, readOnly: true });
      if (p.includes('/dns/explain')) {
        const req = JSON.parse(String(init?.body));
        const asn = req.scenario.asn as number;
        const n = perAsn.get(asn) ?? 0;
        perAsn.set(asn, n + 1);
        return j(buildExplain(req, explain(asn, n)));
      }
      return j({});
    }),
  );
}

describe('Live Steering', () => {
  it('is titled "Current Expected DNS Steering" and states it is expected, not measured', async () => {
    stub(VE, () => ({}));
    renderAt('/live-steering');
    expect(await screen.findByText('Current Expected DNS Steering')).toBeInTheDocument();
    expect(screen.getByText(/not measured traffic/i)).toBeInTheDocument();
  });

  it('shows a live steering path per selected ISP with telemetry-not-connected', async () => {
    stub(VE, () => ({}));
    renderAt('/live-steering');
    expect(await screen.findByRole('heading', { name: /Eir AS5466/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Virgin Media AS6830/ })).toBeInTheDocument();
    // The path renders once the async evaluation resolves.
    expect((await screen.findAllByText(/Cloudflare Load Balancer/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Telemetry not connected/i).length).toBeGreaterThan(0);
    // Pause/resume, refresh, interval, last update controls.
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeInTheDocument();
    expect(screen.getByText(/Last update/)).toBeInTheDocument();
  });

  it('detects a meaningful steering change and records it', async () => {
    // Eir: first evaluation has Réalta eligible; subsequent evaluations remove it.
    stub(VE, (asn, n) => (asn === 5466 && n >= 1 ? { eligible: ['ans-fastly'] } : {}));
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    await waitFor(() => expect(screen.getAllByText(/Réalta, Fastly/).length).toBeGreaterThan(0)); // initial state loaded

    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    // A change is recorded (reason appears both on the card notice and in the panel).
    await waitFor(() => expect(screen.getAllByText(/Eligible platforms: Réalta, Fastly → Fastly/).length).toBeGreaterThan(0));
    const table = screen.getByRole('table'); // the Recent Steering Changes panel
    expect(within(table).getByText('Eir')).toBeInTheDocument();
  });

  it('ignores random Weighted Shuffle ordering (no false change)', async () => {
    // Same eligible set + distribution every call; only the (random) selected answer differs.
    stub(VE, (_asn, n) => ({ eligible: ['ans-realta', 'ans-fastly'], selected: n % 2 === 0 ? 'ans-realta' : 'ans-fastly' }));
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    // No change should be recorded despite the shuffled "selected" answer.
    expect(await screen.findByText(/No steering changes observed/i)).toBeInTheDocument();
  });

  it('gives a NOC viewer the summary notice (no live evaluation)', async () => {
    stub(NOC, () => ({}));
    renderAt('/live-steering');
    expect(await screen.findByText(/Live evaluation requires the Viewing Engineer role/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeDisabled();
  });
});

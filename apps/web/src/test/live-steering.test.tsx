import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import { NOC, VE, ENGINEER, renderAt } from './helpers';
import type { LiveSteeringConfig, LiveSteeringEvent, LiveSteeringState, Principal } from '../api/types';

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error test cleanup of an optionally-stubbed global
  delete window.matchMedia;
});

const CONFIG: LiveSteeringConfig = {
  provenance: { source: 'radar', readOnly: true, label: 'Current Expected DNS Steering', retrievedAt: '2026-07-11T10:00:00Z' },
  maxSelectableIsps: 6,
  pollIntervalsSeconds: [15, 30, 60],
  defaultPollIntervalSeconds: 30,
  highlightSeconds: 10,
  isps: [
    { id: 'eir', name: 'Eir', asn: 5466, ecsPrefix: '185.2.100.0/24', preferredPath: 'Eir PNI' },
    { id: 'virgin', name: 'Virgin Media', asn: 6830, ecsPrefix: '80.233.0.0/24', preferredPath: 'Virgin / Liberty PNI' },
    { id: 'vodafone', name: 'Vodafone', asn: 15502, ecsPrefix: '109.76.0.0/24', preferredPath: 'Eir PNI' },
    { id: 'three', name: 'Three', asn: 34218, ecsPrefix: '37.228.0.0/24', preferredPath: 'Transit' },
    { id: 'sky', name: 'Sky', asn: 5607, ecsPrefix: '2.216.0.0/24', preferredPath: 'Transit' },
    { id: 'digiweb', name: 'Digiweb', asn: 15919, ecsPrefix: '89.19.0.0/24', preferredPath: 'Transit' },
  ],
  records: [{ zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', resourceKey: 'rte.ie/live.rte.ie/A' }],
  reasons: [{ id: 'answer_became_unavailable', label: 'A delivery platform became unavailable' }],
};

function mkState(ispId: string, o: { eligible?: string[]; fingerprint?: string; checksum?: string; complete?: boolean } = {}): LiveSteeringState {
  const isp = CONFIG.isps.find((i) => i.id === ispId)!;
  const eligible = o.eligible ?? ['ans-realta', 'ans-fastly'];
  const labels: Record<string, string> = { 'ans-realta': 'Réalta', 'ans-fastly': 'Fastly' };
  return {
    ispId,
    ispName: isp.name,
    asn: isp.asn,
    resourceKey: 'rte.ie/live.rte.ie/A',
    identitySource: 'ecs',
    country: 'IE',
    matchedPrefix: isp.ecsPrefix,
    preferredPath: isp.preferredPath,
    eligibleAnswerIds: eligible,
    distribution: eligible.map((id) => ({ answerId: id, label: labels[id], deliveryPlatform: labels[id], share: id === 'ans-realta' ? 0.7 : 0.3 })),
    filterChain: ['up', 'weighted_shuffle'],
    complete: o.complete ?? true,
    fingerprint: o.fingerprint ?? `fp-${ispId}-${eligible.join('+')}`,
    structuralChecksum: o.checksum ?? 'sha256:aaaa',
    evaluatedAt: '2026-07-11T10:00:00Z',
    updatedAt: '2026-07-11T10:00:00Z',
  };
}

function mkEvent(id: string, ispId: string, prev: LiveSteeringState, curr: LiveSteeringState, reasonLabel: string): LiveSteeringEvent {
  const isp = CONFIG.isps.find((i) => i.id === ispId)!;
  return {
    id,
    occurredAt: `2026-07-11T10:0${id.replace(/\D/g, '')}:00Z`,
    ispId,
    ispName: isp.name,
    asn: isp.asn,
    resourceKey: 'rte.ie/live.rte.ie/A',
    reason: 'answer_became_unavailable',
    reasonLabel,
    previousFingerprint: prev.fingerprint,
    currentFingerprint: curr.fingerprint,
    previousChecksum: prev.structuralChecksum,
    currentChecksum: curr.structuralChecksum,
    previousState: prev,
    currentState: curr,
    activity: { action: 'update' },
  };
}

const TELEMETRY = (mode: 'mock' | 'disabled') => ({
  provenance: { source: 'radar', telemetryMode: mode, readOnly: true, informationalOnly: true, notice: 'Network telemetry is currently informational. RADAR is not automatically modifying NS1 steering.', retrievedAt: '2026-07-11T15:42:00Z' },
  count: 2,
  items: [
    { pathId: 'eir-pni', pathName: 'Eir PNI', pathType: 'PNI', status: mode === 'disabled' ? 'telemetry_not_connected' : 'healthy', stale: false, freshness: { ageSeconds: mode === 'disabled' ? null : 3, staleAfterSeconds: 120, fresh: mode !== 'disabled' }, configuredCapacityBps: 100e9, configuredTargetPercent: 70, observedInboundBps: mode === 'disabled' ? null : 18e9, observedOutboundBps: mode === 'disabled' ? null : 52e9, observedUtilisationPercent: mode === 'disabled' ? null : 52, observedAt: mode === 'disabled' ? null : '2026-07-11T15:41:57Z', source: mode, provenance: { source: mode, synthetic: mode === 'mock', readOnly: true, informationalOnly: true, note: 'x' } },
    { pathId: 'virgin-liberty-pni', pathName: 'Virgin / Liberty PNI', pathType: 'PNI', status: mode === 'disabled' ? 'telemetry_not_connected' : 'above_target', stale: false, freshness: { ageSeconds: mode === 'disabled' ? null : 3, staleAfterSeconds: 120, fresh: mode !== 'disabled' }, configuredCapacityBps: 100e9, configuredTargetPercent: 70, observedInboundBps: mode === 'disabled' ? null : 25e9, observedOutboundBps: mode === 'disabled' ? null : 74e9, observedUtilisationPercent: mode === 'disabled' ? null : 74, observedAt: mode === 'disabled' ? null : '2026-07-11T15:41:57Z', source: mode, provenance: { source: mode, synthetic: mode === 'mock', readOnly: true, informationalOnly: true, note: 'x' } },
  ],
});

const CACHE_POOLS = (mode: 'mock' | 'disabled') => ({
  provenance: { source: 'radar', telemetryMode: mode, readOnly: true, informationalOnly: true, notice: 'Cache and origin telemetry are informational. RADAR is not automatically modifying NS1 or Cloudflare.', retrievedAt: 'x' },
  count: 1,
  items: [
    { poolId: 'donnybrook-1', poolName: 'Donnybrook Pool 1', site: 'Donnybrook', cacheNodeCount: 2, configuredCapacityBps: 160e9, observedOutboundBps: mode === 'disabled' ? null : 80e9, observedUtilisationPercent: mode === 'disabled' ? null : 50, headroomBps: mode === 'disabled' ? null : 80e9, cpuUtilisationPercent: mode === 'disabled' ? null : 55, memoryUtilisationPercent: mode === 'disabled' ? null : 60, cacheHitRatio: mode === 'disabled' ? null : 0.95, requestRate: mode === 'disabled' ? null : 42000, status: mode === 'disabled' ? 'telemetry_not_connected' : 'healthy', stale: false, freshness: { ageSeconds: mode === 'disabled' ? null : 3, staleAfterSeconds: 120, fresh: mode !== 'disabled' }, observedAt: mode === 'disabled' ? null : 'x', source: mode, provenance: { source: mode, synthetic: mode === 'mock', readOnly: true, informationalOnly: true, note: 'x' } },
  ],
});
const ORIGIN = (mode: 'mock' | 'disabled') => ({
  provenance: { source: 'radar', telemetryMode: mode, readOnly: true, informationalOnly: true, notice: '', retrievedAt: 'x' },
  item: { originId: 'origin', originName: 'Réalta origin', requestRate: mode === 'disabled' ? null : 9000, outboundBandwidthBps: mode === 'disabled' ? null : 120e9, cpuUtilisationPercent: mode === 'disabled' ? null : 62, status: mode === 'disabled' ? 'telemetry_not_connected' : 'healthy', stale: false, freshness: { ageSeconds: mode === 'disabled' ? null : 3, staleAfterSeconds: 120, fresh: mode !== 'disabled' }, observedAt: mode === 'disabled' ? null : 'x', source: mode, provenance: { source: mode, synthetic: mode === 'mock', readOnly: true, informationalOnly: true, note: 'x' } },
});

const DNS_CONFIG = {
  provenance: { source: 'radar', readOnly: true, retrievedAt: 'x' },
  mode: 'mock',
  staleAfterSeconds: 900,
  tierLabels: { predicted: 'Predicted DNS steering', observed: 'Observed DNS answer', traffic: 'Actual traffic — telemetry not connected' },
  comparisonStatuses: ['match', 'partial_match', 'mismatch', 'observation_unavailable', 'confidence_low', 'unknown'],
  confidenceLevels: ['high', 'medium', 'low', 'unknown'],
  scenarios: [{ ispId: 'eir', ispName: 'Eir', asn: 5466, country: 'IE', resolvers: ['192.0.2.11'], ecsSubnet: '203.0.113.0/24', zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A', expectedRepresentativeness: 'medium', provenance: 'MOCK', notes: '' }],
};
const dnsObservation = (ispId: string, status: string, addresses: string[]) => ({
  id: `obs-${ispId}-${status}`, observedAt: '2026-07-11T15:41:00Z', freshness: { ageSeconds: 5, staleAfterSeconds: 900, fresh: true },
  ispId, ispName: ispId === 'eir' ? 'Eir' : 'Virgin Media', asn: ispId === 'eir' ? 5466 : 6830, resolverIp: '192.0.2.11', zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A',
  responseCode: 'NOERROR', ecsRequested: true, ecsPrefix: '203.0.113.0/24', ecsHonoured: true, ttl: 30, latencyMs: 12, confidence: 'medium',
  comparisonStatus: status, matchStatus: status, differences: [], observedAnswers: addresses.map((a) => ({ type: 'A', address: a })), predictedAnswers: [], predictedDistribution: [], observedOrder: addresses, recordChecksum: 'sha256:x',
  explanation: 'ok', warnings: [], provenance: { source: 'radar', label: 'Observed DNS answer', readOnly: true },
});
const dnsState = (eirStatus: string, eirAddrs: string[]) => ({
  provenance: { source: 'radar', readOnly: true, retrievedAt: 'x' },
  tierLabels: DNS_CONFIG.tierLabels,
  count: 2,
  items: [
    { ispId: 'eir', ispName: 'Eir', asn: 5466, observation: dnsObservation('eir', eirStatus, eirAddrs) },
    { ispId: 'virgin', ispName: 'Virgin Media', asn: 6830, observation: null },
  ],
});

interface StubOpts {
  state?: (ispId: string) => LiveSteeringState | undefined;
  events?: (callIndex: number) => LiveSteeringEvent[];
  eventsFail?: () => boolean;
  telemetryMode?: 'mock' | 'disabled';
}

const SHED = {
  provenance: { source: 'radar', readOnly: true, write: false, telemetrySource: 'cloudvision', label: 'Shed signals', observedAt: '2026-07-20T21:00:00Z', retrievedAt: '2026-07-20T21:00:05Z' },
  connected: true,
  defaultWatermarks: [{ id: 'eir', low: 78, high: 90 }, { id: 'inex', low: 75, high: 90 }],
  datacentres: [{ id: 'citywest', name: 'Citywest' }, { id: 'parkwest', name: 'Parkwest' }],
  isps: [
    { id: 'eir', name: 'Eir', asn: 5466, viaInex: false, isInex: false, watermark: { low: 78, high: 90 },
      cells: [
        { dc: 'citywest', active: true, capacityBps: 1e11, primaryBps: 5e10, utilisationPercent: 50, interfaceNames: ['Port-Channel7'] },
        { dc: 'parkwest', active: true, capacityBps: 1e11, primaryBps: 9.4e10, utilisationPercent: 94, interfaceNames: ['Port-Channel7'] },
      ],
      combined: { capacityBps: 2e11, primaryBps: 1.44e11, utilisationPercent: 72 } },
    { id: 'inex', name: 'INEX (IX)', asn: null, viaInex: false, isInex: true, watermark: { low: 75, high: 90 },
      cells: [
        { dc: 'citywest', active: true, capacityBps: 1e11, primaryBps: 3e10, utilisationPercent: 30, interfaceNames: ['Port-Channel1'] },
        { dc: 'parkwest', active: true, capacityBps: 1e11, primaryBps: 5e10, utilisationPercent: 50, interfaceNames: ['Port-Channel2'] },
      ],
      combined: { capacityBps: 2e11, primaryBps: 8e10, utilisationPercent: 40 } },
  ],
};

const CF_LBS = {
  items: [{
    id: 'lb-live', name: 'liveedge.rte.ie', zoneName: 'rte.ie', enabled: true, proxied: false, steeringPolicy: 'random',
    defaultPools: [
      { poolId: 'p-cw', poolName: 'realta-citywest', weight: 0.25 },
      { poolId: 'p-pw', poolName: 'realta-parkwest', weight: 0.25 },
      { poolId: 'p-mam', poolName: 'realta-mam', weight: 0.25 },
      { poolId: 'p-dad', poolName: 'realta-dad', weight: 0.25 },
    ],
    fallbackPool: null, regionPools: {}, popPools: {}, countryPools: {},
    sessionAffinity: null, sessionAffinityTtl: null, sessionAffinityAttributes: null,
    locationStrategy: null, adaptiveRoutingFailoverAcrossPools: null, randomSteeringDefaultWeight: 1, ttlSeconds: 30,
    observed: { windowHours: 1, totalRequests: 1000, byRegion: [], byColo: [], byOrigin: [], byPool: [
      { key: 'realta-citywest', requests: 500, sharePercent: 50 },
      { key: 'realta-parkwest', requests: 300, sharePercent: 30 },
      { key: 'realta-mam', requests: 120, sharePercent: 12 },
      { key: 'realta-dad', requests: 80, sharePercent: 8 },
    ] },
  }],
};
const cfPool = (id: string, name: string, healthy: number, total: number) => ({ id, name, description: null, enabled: true, healthy: true, monitorId: null, healthCheck: null, minimumOrigins: null, origins: [], healthyOrigins: healthy, totalOrigins: total, originSteeringPolicy: null, loadShedding: null, checkRegions: [], notificationEmail: null });
const CF_POOLS = { items: [cfPool('p-cw', 'realta-citywest', 4, 4), cfPool('p-pw', 'realta-parkwest', 4, 4), cfPool('p-mam', 'realta-mam', 2, 2), cfPool('p-dad', 'realta-dad', 1, 2)] };

function stub(principal: Principal, opts: StubOpts = {}) {
  let eventsCall = 0;
  let dnsRuns = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const p = url.split('?')[0];
      calls.push(url);
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/api/v1/me')) return j(principal);
      if (p.endsWith('/dns-observation/config')) return j(DNS_CONFIG);
      if (p.endsWith('/dns-observation/run')) { dnsRuns += 1; return j({ provenance: {}, tierLabels: DNS_CONFIG.tierLabels, count: 1, results: [] }); }
      if (p.endsWith('/dns-observation/state')) return j(dnsRuns > 0 ? dnsState('mismatch', ['198.51.100.9']) : dnsState('match', ['192.0.2.10', '192.0.2.20']));
      if (p.endsWith('/ns1/config')) return j({ mode: 'mock', synthetic: true, readOnly: true });
      if (p.endsWith('/telemetry/network-paths')) return j(TELEMETRY(opts.telemetryMode ?? 'mock'));
      if (p.endsWith('/telemetry/cache-pools')) return j(CACHE_POOLS(opts.telemetryMode ?? 'mock'));
      if (p.endsWith('/telemetry/cache-nodes')) return j({ provenance: { source: 'radar', telemetryMode: opts.telemetryMode ?? 'mock', readOnly: true, informationalOnly: true, notice: '', retrievedAt: 'x' }, count: 0, items: [] });
      if (p.endsWith('/telemetry/origin')) return j(ORIGIN(opts.telemetryMode ?? 'mock'));
      if (p.endsWith('/live-steering/config')) return j(CONFIG);
      if (p.endsWith('/live-steering/state')) {
        const isp = new URL(url, 'http://x').searchParams.get('isp') ?? '';
        const s = opts.state ? opts.state(isp) : mkState(isp);
        return j({ provenance: CONFIG.provenance, count: s ? 1 : 0, items: s ? [s] : [] });
      }
      if (p.endsWith('/live-steering/events')) {
        if (opts.eventsFail?.()) return j({ code: 'INTERNAL_ERROR', message: 'boom' }, 500);
        const items = opts.events ? opts.events(eventsCall) : [];
        eventsCall += 1;
        return j({ provenance: CONFIG.provenance, count: items.length, items });
      }
      if (p.endsWith('/live-steering/shed-signals')) return j(SHED);
      if (p.endsWith('/network/cloudflare/load-balancers')) return j(CF_LBS);
      if (p.endsWith('/network/cloudflare/pools')) return j(CF_POOLS);
      return j({});
    }),
  );
  return { calls };
}

describe('Live Steering', () => {
  it('is titled "Current Expected DNS Steering" and states it is expected, not measured', async () => {
    stub(VE);
    renderAt('/live-steering');
    expect(await screen.findByText('Current Expected DNS Steering')).toBeInTheDocument();
    expect(screen.getByText(/not measured traffic/i)).toBeInTheDocument();
  });

  it('Shed signals tab: renders the per-ISP × DC grid and computes NS1 shed_load gating from live util', async () => {
    stub(VE);
    renderAt('/live-steering');
    await screen.findByText('Current Expected DNS Steering');
    await userEvent.click(screen.getByRole('tab', { name: /Shed signals/i }));
    // Grid header + rows.
    expect(await screen.findByRole('columnheader', { name: 'Citywest' })).toBeInTheDocument();
    expect(screen.getByText('INEX (IX)')).toBeInTheDocument();
    const eirRow = screen.getByText('Eir').closest('tr')!;
    // Eir Citywest 50% (below low 78) → served, no shed badge; Parkwest 94% (≥ high 90) → full shed.
    expect(within(eirRow).getByText('50%')).toBeInTheDocument();
    expect(within(eirRow).getByText('94%')).toBeInTheDocument();
    expect(within(eirRow).getAllByText(/shed 100%/i).length).toBeGreaterThan(0);
    // Combined 72% is below Eir's default low (78) → the gating pill reads "serve".
    expect(within(eirRow).getByText('serve')).toBeInTheDocument();
    // Watermark sliders are present (adjustable).
    expect(within(eirRow).getAllByRole('slider').length).toBe(2);
  });

  it('Shed signals: engineer gets the guarded TTL lever, which PUTs the TTL to the livetest candidate', async () => {
    stub(ENGINEER);
    renderAt('/live-steering');
    await screen.findByText('Current Expected DNS Steering');
    await userEvent.click(screen.getByRole('tab', { name: /Shed signals/i }));
    expect(await screen.findByText(/TTL lever/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Set TTL 30s/i }));
    expect(await screen.findByText(/R_max now ≈ 3\.00/i)).toBeInTheDocument(); // 90/30 = 3.00 %/s
    // Drain bar: the old 180s cache generation must expire before the 30s is valid everywhere.
    expect(await screen.findByText(/Old 180s caches draining/i)).toBeInTheDocument();
    // It writes via the guarded create/apply path, scoped to the livetest candidate, TTL 30, CNAME only.
    const applyCall = (fetch as unknown as Mock).mock.calls.find((c: unknown[]) => String(c[0]).includes('/ns1/records/apply'));
    expect(applyCall).toBeTruthy();
    expect(JSON.parse(String((applyCall![1] as RequestInit).body))).toMatchObject({ zone: 'livetest.rte.ie', domain: 'shed.livetest.rte.ie', type: 'CNAME', ttl: 30 });
  });

  it('DC balancer tab: shows the four pools with capacity-proportional recommended weights', async () => {
    stub(VE); // topology.summary.read is enough to read Cloudflare
    renderAt('/live-steering');
    await screen.findByText('Current Expected DNS Steering');
    await userEvent.click(screen.getByRole('tab', { name: /DC balancer/i }));
    expect((await screen.findAllByText('Citywest')).length).toBeGreaterThan(0); // pool name + site column
    expect(screen.getByText('Mam')).toBeInTheDocument();
    // Capacity = healthy caches × per-cache Gb/s: CW 4×80=320, PW 320, Mam 2×20=40, Dad 1×20=20 (a cache down). Total 700.
    const cwRow = screen.getAllByText('Citywest')[0].closest('tr')!;
    expect(within(cwRow).getByText(/320 G/)).toBeInTheDocument();
    expect(within(cwRow).getByText(/46%/)).toBeInTheDocument(); // 320/700 = 45.7% recommended
    const dadRow = screen.getByText('Dad').closest('tr')!;
    expect(within(dadRow).getByText('1/2')).toBeInTheDocument(); // one Donnybrook cache down
    expect(within(dadRow).getByText(/degraded/i)).toBeInTheDocument();
  });

  it('Shed signals: the TTL lever is hidden without the write permission', async () => {
    stub(VE);
    renderAt('/live-steering');
    await screen.findByText('Current Expected DNS Steering');
    await userEvent.click(screen.getByRole('tab', { name: /Shed signals/i }));
    await screen.findByRole('columnheader', { name: 'Citywest' });
    expect(screen.queryByText(/TTL lever/i)).not.toBeInTheDocument();
  });

  it('shows a steering path per selected ISP with telemetry-not-connected, and never labels it actual traffic', async () => {
    stub(VE);
    renderAt('/live-steering');
    expect(await screen.findByRole('heading', { name: /Eir AS5466/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Virgin Media AS6830/ })).toBeInTheDocument();
    expect((await screen.findAllByText(/Cloudflare Load Balancer/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Telemetry not connected/i).length).toBeGreaterThan(0);
    // The distribution is explicitly the EXPECTED distribution, never actual traffic share.
    expect(screen.getAllByText(/Expected DNS distribution/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeInTheDocument();
    expect(screen.getByText(/Last update/)).toBeInTheDocument();
  });

  it('only polls the events endpoint (never re-evaluates via /dns/explain)', async () => {
    const { calls } = stub(VE);
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    await waitFor(() => expect(calls.some((c) => c.includes('/live-steering/events'))).toBe(true));
    expect(calls.some((c) => c.includes('/dns/explain'))).toBe(false);
  });

  it('lets the user select up to six ISPs by checkbox', async () => {
    stub(VE);
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    // Eir + Virgin are selected by default; Three is not yet shown as a card.
    expect(screen.queryByRole('heading', { name: /Three AS34218/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Three/ }));
    expect(await screen.findByRole('heading', { name: /Three AS34218/ })).toBeInTheDocument();
  });

  it('highlights the affected ISP and records a persisted change; unaffected ISPs do not highlight', async () => {
    // Backlog is empty on the first (priming) poll; the second poll delivers a change for Eir.
    const prev = mkState('eir', { eligible: ['ans-realta', 'ans-fastly'], fingerprint: 'fp-eir-1', checksum: 'sha256:aaaa' });
    const curr = mkState('eir', { eligible: ['ans-fastly'], fingerprint: 'fp-eir-2', checksum: 'sha256:bbbb' });
    const ev = mkEvent('e1', 'eir', prev, curr, 'A delivery platform became unavailable');
    stub(VE, { events: (n) => (n === 0 ? [] : [ev]) });
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    await waitFor(() => expect(screen.getAllByText(/Réalta, Fastly/).length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    // The reason renders (card notice + Recent panel), previous → current is shown.
    await waitFor(() => expect(screen.getAllByText(/A delivery platform became unavailable/).length).toBeGreaterThan(0));
    const eirCard = screen.getByRole('heading', { name: /Eir AS5466/ }).closest('.isp-card')!;
    expect(eirCard.className).toContain('changed');
    expect(within(eirCard as HTMLElement).getByText(/Steering changed\./)).toBeInTheDocument();
    // Unaffected ISP (Virgin) is not highlighted.
    const virginCard = screen.getByRole('heading', { name: /Virgin Media AS6830/ }).closest('.isp-card')!;
    expect(virginCard.className).not.toContain('changed');
    // The change is persisted in Recent Steering Changes.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Eir')).toBeInTheDocument();
  });

  it('does not re-highlight events that already existed when the page loaded', async () => {
    const prev = mkState('eir', { fingerprint: 'fp-eir-1' });
    const curr = mkState('eir', { eligible: ['ans-fastly'], fingerprint: 'fp-eir-2' });
    const ev = mkEvent('e1', 'eir', prev, curr, 'A delivery platform became unavailable');
    // The event is in the backlog on the FIRST poll → shown in Recent, but never highlighted.
    stub(VE, { events: () => [ev] });
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('Eir')).toBeInTheDocument());
    const eirCard = screen.getByRole('heading', { name: /Eir AS5466/ }).closest('.isp-card')!;
    expect(eirCard.className).not.toContain('changed');
  });

  it('disables the highlight animation when the user prefers reduced motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    const prev = mkState('eir', { fingerprint: 'fp-eir-1' });
    const curr = mkState('eir', { eligible: ['ans-fastly'], fingerprint: 'fp-eir-2' });
    const ev = mkEvent('e1', 'eir', prev, curr, 'A delivery platform became unavailable');
    stub(VE, { events: (n) => (n === 0 ? [] : [ev]) });
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      const eirCard = screen.getByRole('heading', { name: /Eir AS5466/ }).closest('.isp-card')!;
      expect(eirCard.className).toContain('changed');
      expect(eirCard.className).toContain('no-animate');
    });
  });

  it('shows a stale indicator after an events-polling failure', async () => {
    let fail = false;
    stub(VE, { eventsFail: () => fail });
    renderAt('/live-steering');
    await screen.findByRole('heading', { name: /Eir AS5466/ });
    fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(await screen.findByText('stale')).toBeInTheDocument();
  });

  it('lets a NOC viewer see the steering summary (steering.summary.read)', async () => {
    stub(NOC);
    renderAt('/live-steering');
    // NOC has steering.summary.read, so the cards render (no "requires role" block).
    expect(await screen.findByRole('heading', { name: /Eir AS5466/ })).toBeInTheDocument();
    expect(screen.queryByText(/Live evaluation requires/i)).not.toBeInTheDocument();
  });

  it('shows an access notice to a principal without steering.summary.read', async () => {
    const noAccess: Principal = { ...NOC, permissions: [] };
    stub(noAccess);
    renderAt('/live-steering');
    expect(await screen.findByText(/Live evaluation requires/i)).toBeInTheDocument();
  });

  it('shows fresh network-path telemetry per ISP (replacing the not-connected placeholder)', async () => {
    stub(VE, { telemetryMode: 'mock' });
    renderAt('/live-steering');
    const eirCard = (await screen.findByRole('heading', { name: /Eir AS5466/ })).closest('.isp-card')!;
    // Fresh observed utilisation for the Eir PNI path appears on the Eir card…
    const pathTele = (await within(eirCard as HTMLElement).findByText(/52\.0%/)).closest('.path-telemetry')! as HTMLElement;
    expect(within(pathTele).getByText('healthy')).toBeInTheDocument();
    // …while actual CDN traffic share remains explicitly not connected.
    expect(within(eirCard as HTMLElement).getByText(/Actual traffic \/ experience/)).toBeInTheDocument();
    // The informational, not-controlling notice is shown.
    expect(screen.getByText(/not automatically modifying NS1 steering/i)).toBeInTheDocument();
  });

  it('shows Réalta pool + origin delivery context with the responsibility boundary', async () => {
    stub(VE, { telemetryMode: 'mock' });
    renderAt('/live-steering');
    const eirCard = (await screen.findByRole('heading', { name: /Eir AS5466/ })).closest('.isp-card')! as HTMLElement;
    // Réalta is eligible for Eir → the delivery context renders.
    expect(await within(eirCard).findByText(/Réalta pools/)).toBeInTheDocument();
    expect(within(eirCard).getByText(/Cloudflare selects the pool/)).toBeInTheDocument();
    expect(within(eirCard).getByText(/Origin/)).toBeInTheDocument();
  });

  it('renders three separate tiers: predicted steering, observed DNS answer, and (not connected) actual traffic', async () => {
    stub(VE);
    renderAt('/live-steering');
    const eirCard = (await screen.findByRole('heading', { name: /Eir AS5466/ })).closest('.isp-card')! as HTMLElement;
    expect(await within(eirCard).findByText('Predicted DNS steering')).toBeInTheDocument();
    expect(within(eirCard).getByText('Observed DNS answer')).toBeInTheDocument();
    expect(within(eirCard).getByText('Actual traffic / experience')).toBeInTheDocument();
    // Observed tier shows the comparison status and does not claim traffic.
    expect(await within(eirCard).findByText('match')).toBeInTheDocument();
    expect(within(eirCard).getByText(/not measured/i)).toBeInTheDocument();
    // A Viewing Engineer can trigger a manual observation.
    expect(within(eirCard).getByRole('button', { name: /Run DNS observation/ })).toBeInTheDocument();
  });

  it('highlights the observed-DNS tier when an observation changes (distinct from a steering change)', async () => {
    stub(VE);
    renderAt('/live-steering');
    const eirCard = (await screen.findByRole('heading', { name: /Eir AS5466/ })).closest('.isp-card')! as HTMLElement;
    await within(eirCard).findByText('match'); // primed with the initial observation
    await userEvent.click(within(eirCard).getByRole('button', { name: /Run DNS observation/ }));
    // The re-observation returns a mismatch → the observed-DNS tier highlights.
    await waitFor(() => {
      const tier = eirCard.querySelector('.observation-tier')!;
      expect(tier.className).toContain('changed');
      expect(within(tier as HTMLElement).getByText('mismatch')).toBeInTheDocument();
    });
  });

  it('keeps "Telemetry not connected" when telemetry is disabled', async () => {
    stub(VE, { telemetryMode: 'disabled' });
    renderAt('/live-steering');
    const eirCard = (await screen.findByRole('heading', { name: /Eir AS5466/ })).closest('.isp-card')!;
    // Both the path-utilisation line and the CDN-share line stay "Telemetry not connected".
    expect((await within(eirCard as HTMLElement).findAllByText('Telemetry not connected')).length).toBeGreaterThanOrEqual(1);
    // The informational notice is not shown when telemetry is disabled.
    expect(screen.queryByText(/not automatically modifying NS1 steering/i)).not.toBeInTheDocument();
  });
});

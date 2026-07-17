// Réalta Cache Load Balancing page: renders the summary, the load-balancer steering (pools
// resolved to names) and the origin pools with their caches + health, from the mock API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, renderAt, stubApi } from './helpers';

const SEEDED_KEY = 'radar.cacheLb.defaultsSeeded.v1';
// The default focused view auto-pins the primary delivery LBs/pools on first visit; mark it seeded
// so the toggle tests start from an empty focused view (one test below opts back in).
beforeEach(() => localStorage.setItem(SEEDED_KEY, '1'));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('Réalta Cache Load Balancing page', () => {
  it('shows steering (pools resolved to names) and pools with origin health', async () => {
    stubApi(NOC);
    renderAt('/realta-cache');

    // Wait for the page + data (AuthProvider resolves asynchronously) before synchronous asserts.
    const lbRow = within((await screen.findByText('liveedge.rte.ie')).closest('tr')!);
    expect(screen.getByRole('heading', { name: /^Load Balancing$/, level: 1 })).toBeInTheDocument();
    expect(lbRow.getByText('random')).toBeInTheDocument(); // steering policy
    expect(lbRow.getAllByText('live-realta-citywest').length).toBeGreaterThan(0); // pool resolved to name (chip + fallback)

    // Pools + origins: the citywest pool, its health-check spec, and its caches (one unhealthy).
    expect(screen.getAllByText(/player\/monitoring\/alive/).length).toBeGreaterThan(0); // health-check spec
    expect(screen.getByText('cdn-mem-ctw-1')).toBeInTheDocument();
    expect(screen.getByText('185.54.105.4')).toBeInTheDocument(); // an origin address
    expect(screen.getAllByText('unhealthy').length).toBeGreaterThan(0); // the unhealthy origin

    // Observed traffic (LB analytics): the configured pool shows its observed share.
    expect(lbRow.getByText(/50\.4%/)).toBeInTheDocument();

    // Summary reflects the connector snapshot.
    const tile = screen.getByText('Unhealthy origins').closest('.card')! as HTMLElement;
    expect(within(tile).getByText('1')).toBeInTheDocument();
  });

  it('seeds a default focused view on first visit (auto-pins the primary delivery LBs)', async () => {
    localStorage.removeItem(SEEDED_KEY); // first visit
    stubApi(NOC);
    renderAt('/realta-cache');
    // liveedge.rte.ie is a default → it pins into the focused view with no user action.
    const focused = (await screen.findByText(/Focused load balancers/)).closest('.focused-lbs') as HTMLElement;
    expect(within(focused).getByText('liveedge.rte.ie')).toBeInTheDocument();
  });

  it('pins a load balancer into a focused view at the top, and unpins it', async () => {
    stubApi(NOC);
    renderAt('/realta-cache');

    // No focused view until something is pinned.
    await screen.findByText('liveedge.rte.ie');
    expect(screen.queryByText(/Focused load balancers/)).not.toBeInTheDocument();

    // Tick the row checkbox → the LB appears in the focused view.
    fireEvent.click(screen.getByLabelText('Pin liveedge.rte.ie'));
    const focused = screen.getByText(/Focused load balancers/).closest('.focused-lbs') as HTMLElement;
    expect(within(focused).getByText('liveedge.rte.ie')).toBeInTheDocument();
    expect(within(focused).getByText('random')).toBeInTheDocument(); // steering policy shown in the card

    // Unpin via the card's ✕ removes the focused view.
    fireEvent.click(within(focused).getByLabelText('Unpin liveedge.rte.ie'));
    expect(screen.queryByText(/Focused load balancers/)).not.toBeInTheDocument();
  });

  it('surfaces richer data: per-origin RTT, pool origin-steering, session affinity, adaptive routing', async () => {
    stubApi(NOC);
    renderAt('/load-balancing');
    await screen.findByText('cdn-mem-ctw-1');

    expect(screen.getByText('12 ms')).toBeInTheDocument(); // per-origin RTT from the pool health endpoint
    expect(screen.getByText('10.5 ms')).toBeInTheDocument(); // load-balancer RTT (weighted mean of its pools: 0.5·12 + 0.5·9)
    expect(screen.getAllByText(/origins: least_outstanding_requests/).length).toBeGreaterThan(0); // pool origin steering
    expect(screen.getByText(/affinity: cookie 1800s · adaptive failover/)).toBeInTheDocument(); // LB session affinity + adaptive routing
  });

  it('pins an origin pool into a focused pools view', async () => {
    stubApi(NOC);
    renderAt('/load-balancing');
    await screen.findByText('cdn-mem-ctw-1');
    expect(screen.queryByText(/Focused pools/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Pin live-realta-citywest'));
    const focused = screen.getByText(/Focused pools/).closest('.focused-lbs') as HTMLElement;
    expect(within(focused).getByText('cdn-mem-ctw-1')).toBeInTheDocument();
    // The pinned pool is live-refreshed on the fast tier, which overlays a fresher RTT (mock: 99 ms).
    expect((await within(focused).findAllByText('99 ms')).length).toBeGreaterThan(0);
  });
});

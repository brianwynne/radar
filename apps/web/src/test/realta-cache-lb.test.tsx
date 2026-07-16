// Réalta Cache Load Balancing page: renders the summary, the load-balancer steering (pools
// resolved to names) and the origin pools with their caches + health, from the mock API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { NOC, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Réalta Cache Load Balancing page', () => {
  it('shows steering (pools resolved to names) and pools with origin health', async () => {
    stubApi(NOC);
    renderAt('/realta-cache');

    // Wait for the page + data (AuthProvider resolves asynchronously) before synchronous asserts.
    const lbRow = within((await screen.findByText('liveedge.rte.ie')).closest('tr')!);
    expect(screen.getByRole('heading', { name: /Cache Load Balancing/, level: 1 })).toBeInTheDocument();
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
});

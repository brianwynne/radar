import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Network-path telemetry — Topology', () => {
  it('renders live path status in the Network paths card', async () => {
    stubApi(VE);
    renderAt('/topology');
    const heading = await screen.findByRole('heading', { name: 'Network paths' });
    const card = heading.closest('.card')! as HTMLElement;
    expect(await within(card).findByText('Eir PNI')).toBeInTheDocument();
    expect(within(card).getByText('above target')).toBeInTheDocument(); // Virgin
    // Capacity/target are still labelled CONFIGURED (distinct from observed).
    expect(within(card as HTMLElement).getByText(/Capacity and target are CONFIGURED/)).toBeInTheDocument();
  });
});

describe('Cache/origin telemetry — Topology', () => {
  it('shows pools, the responsibility boundary and origin', async () => {
    stubApi(VE);
    renderAt('/topology');
    const heading = await screen.findByRole('heading', { name: /Réalta cache pools, nodes & origin/ });
    const card = heading.closest('.card')! as HTMLElement;
    expect(await within(card).findByText('Donnybrook Pool 1')).toBeInTheDocument();
    expect(within(card).getByText(/Cloudflare selects the pool/)).toBeInTheDocument();
    expect(within(card).getByText('Réalta origin')).toBeInTheDocument();
    // Detailed view shows the cache-node table too.
    expect(within(card).getByText('Cache nodes')).toBeInTheDocument();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Network-path telemetry — Dashboard', () => {
  it('shows path status and utilisation to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/');
    const heading = await screen.findByText('Network path utilisation');
    const card = heading.closest('.card')! as HTMLElement;
    const table = await within(card).findByRole('table');
    expect(within(table).getByText('Eir PNI')).toBeInTheDocument();
    expect(within(table).getByText('healthy')).toBeInTheDocument();
    expect(within(table).getByText('critical')).toBeInTheDocument(); // Transit
    // The informational, not-controlling notice is present.
    expect(screen.getByText(/not automatically modifying NS1 steering/i)).toBeInTheDocument();
  });
});

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

describe('Cache/origin telemetry — Dashboard', () => {
  it('shows cache-pool status and origin health to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/');
    const heading = await screen.findByRole('heading', { name: /Réalta cache pools & origin/ });
    const card = heading.closest('.card')! as HTMLElement;
    expect(await within(card).findByText('Donnybrook Pool 1')).toBeInTheDocument();
    expect(within(card).getByText('warning')).toBeInTheDocument(); // External Pool 1
    expect(within(card).getByText('Réalta origin')).toBeInTheDocument();
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

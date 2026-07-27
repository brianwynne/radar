// Dashboard composes three at-a-glance sections: the steering overview (every ISP, on the active
// record), the top-10 network interfaces, and the pinned/focused origin pools — with role gating.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('Dashboard', () => {
  it('shows top interfaces + focused pools to a NOC viewer; steering needs Viewing Engineer', async () => {
    stubApi(NOC);
    renderAt('/');
    expect(await screen.findByRole('heading', { name: /NOC Overview/i })).toBeInTheDocument();
    // Live delivery pie: total live throughput + the eyeball/commercial slices + 1-hour average.
    expect(await screen.findByRole('heading', { name: 'Live delivery mix' })).toBeInTheDocument();
    // Wait for the async delivery data to load (the PNI utilisation section renders once it has).
    expect(await screen.findByText(/PNI utilisation/)).toBeInTheDocument();
    const pie = screen.getByRole('heading', { name: 'Live delivery mix' }).closest('.delivery-pie') as HTMLElement;
    expect(pie).toHaveTextContent('Eir');
    expect(pie).toHaveTextContent('INEX'); // public IX peering slice
    expect(pie).toHaveTextContent('2 links'); // multi-link PNI shown in the legend
    expect(pie).toHaveTextContent('Fastly');
    expect(pie).toHaveTextContent('9.5 Gb/s'); // 9.5e9 total live
    // Aggregate PNI utilisation (throughput ÷ total capacity, NOT the mix share): Eir 4 Gb/s of 200 Gb/s = 2%.
    expect(pie).toHaveTextContent('2.0%');
    expect(pie).toHaveTextContent('200 Gb/s'); // Eir total capacity across both links
    // Per-link detail is collapsed by default; expand Eir → both links + each link's utilisation.
    expect(within(pie).queryByText('edge-citywest-router')).toBeNull();
    fireEvent.click(within(pie).getByRole('button', { name: /Eir/ }));
    expect(await within(pie).findByText('edge-citywest-router')).toBeInTheDocument();
    expect(within(pie).getByText('2.2%')).toBeInTheDocument(); // Eir citywest link utilisation
    expect(await screen.findByRole('heading', { name: 'Top 10 network interfaces' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Focused pools' })).toBeInTheDocument();
    // NOC lacks dns.explain.read → the steering overview is gated.
    expect(screen.getByText(/Steering overview requires the Viewing Engineer role/i)).toBeInTheDocument();
  });

  it('renders the per-ISP steering overview for a Viewing Engineer, on the active record', async () => {
    stubApi(VE);
    renderAt('/');
    expect(await screen.findByText(/Steering overview — every ISP/i)).toBeInTheDocument();
    expect(screen.getByText(/live\.rte\.ie/)).toBeInTheDocument(); // resolved from the active record
  });
});

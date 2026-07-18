// Dashboard composes three at-a-glance sections: the steering overview (every ISP, on the active
// record), the top-10 network interfaces, and the pinned/focused origin pools — with role gating.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('Dashboard', () => {
  it('shows top interfaces + focused pools to a NOC viewer; steering needs Viewing Engineer', async () => {
    stubApi(NOC);
    renderAt('/');
    expect(await screen.findByRole('heading', { name: /NOC Overview/i })).toBeInTheDocument();
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

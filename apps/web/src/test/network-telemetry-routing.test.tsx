// Routing Intelligence tab (bgp.tools) inside Network Telemetry: overview, prefix visibility
// matrix (worst-first), drawer evidence, and the incident feed — from the stubbed routing API.
import { describe, expect, it } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, renderAt, stubApi } from './helpers';

const openTab = () => fireEvent.click(screen.getByRole('button', { name: 'Routing Intelligence' }));

describe('Routing Intelligence tab', () => {
  it('shows the overview, the visibility matrix worst-first, and an incident', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByRole('heading', { name: 'Network Telemetry', level: 1 });
    openTab();

    // Live badge + overall critical integrity.
    expect(await screen.findByText('LIVE · bgp.tools')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Routing Intelligence/ })).toBeInTheDocument();

    // Prefix matrix present; the critical /24 sorts above the healthy /22.
    const matrix = screen.getByRole('columnheader', { name: 'Visibility' }).closest('table')! as HTMLElement;
    const rows = within(matrix).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('89.207.57.0/24')).toBeInTheDocument(); // critical first
    expect(within(rows[0]).queryByText('withdrawn')).toBeNull(); // not withdrawn, just low-vis
    expect(within(matrix).getByText('185.54.104.0/22')).toBeInTheDocument();
    expect(within(matrix).getByText('Critical')).toBeInTheDocument();
    expect(within(matrix).getByText('Healthy')).toBeInTheDocument();

    // Incident feed shows the visibility-loss incident.
    expect(screen.getByText('Visibility loss')).toBeInTheDocument();
  });

  it('opens the evidence drawer for a prefix', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByRole('heading', { name: 'Network Telemetry', level: 1 });
    openTab();
    const row = await screen.findByText('185.54.104.0/22');
    fireEvent.click(row);
    // Drawer reveals the upstreams evidence.
    expect(await screen.findByText(/AS174/)).toBeInTheDocument();
  });
});

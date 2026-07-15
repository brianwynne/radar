// Network Telemetry (CloudVision) page: renders summary, provider cards, interface + BGP
// tables from the mock API, shows the mock/informational provenance, and filters interfaces.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Network Telemetry page', () => {
  it('shows summary, provider cards, interfaces and BGP peers to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/network');

    // Wait for data-dependent content (the interface row) before synchronous assertions.
    expect(await screen.findByText('Eir PNI Dublin')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Network Telemetry', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('MOCK · SYNTHETIC')).toBeInTheDocument();
    expect(screen.getByText(/read-only and informational/i)).toBeInTheDocument();

    // Provider cards render (the "Healthy links" kv is unique to a provider card).
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeInTheDocument();
    expect(screen.getAllByText('Healthy links').length).toBeGreaterThan(0);

    // Interface + BGP content.
    expect(screen.getAllByText('down').length).toBeGreaterThan(0); // transit oper/status
    expect(screen.getByText('185.6.36.1')).toBeInTheDocument();
    expect(screen.getByText('established')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('filters interfaces by link type', async () => {
    stubApi(VE);
    renderAt('/network');
    expect(await screen.findByText('Eir PNI Dublin')).toBeInTheDocument();

    // Filter to TRANSIT only → Eir peering row disappears, transit remains.
    fireEvent.change(screen.getByLabelText('Link type'), { target: { value: 'TRANSIT' } });
    expect(screen.queryByText('Eir PNI Dublin')).not.toBeInTheDocument();
    expect(screen.getByText('Transit Cogent')).toBeInTheDocument();
  });

  it('lists devices and drills into one to filter interfaces + BGP', async () => {
    stubApi(NOC);
    renderAt('/network');
    // Devices panel lists both devices (edge2 appears only there).
    const edge2 = await screen.findByText('edge2.dub.rte.ie');
    expect(screen.getByRole('heading', { name: /Devices/ })).toBeInTheDocument();
    // Before selecting, the edge1 Eir interface is visible.
    expect(screen.getByText('Eir PNI Dublin')).toBeInTheDocument();
    // Select edge2 (which has no interfaces) → edge1 interfaces filtered out.
    fireEvent.click(edge2);
    expect(await screen.findByText(/Showing/)).toBeInTheDocument();
    expect(screen.queryByText('Eir PNI Dublin')).not.toBeInTheDocument();
  });

  it('summary tiles reflect the connector snapshot', async () => {
    stubApi(NOC);
    renderAt('/network');
    // Await data before reading the (data-dependent) tile value.
    await screen.findByText('Eir PNI Dublin');
    const tile = screen.getByText('Unhealthy links').closest('.card')! as HTMLElement;
    expect(within(tile).getByText('1')).toBeInTheDocument();
  });
});

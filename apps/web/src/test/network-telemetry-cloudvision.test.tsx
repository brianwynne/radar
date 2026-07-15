// Network Telemetry (CloudVision) page: renders summary, provider cards, interface + BGP
// tables from the mock API, shows the mock/informational provenance, and filters interfaces.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, VE, ENGINEER, renderAt, stubApi } from './helpers';

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
    // Select edge2 by its device id (unique to the Devices table).
    const edge2 = await screen.findByText('JPE00000002');
    expect(screen.getByRole('heading', { name: /Devices/ })).toBeInTheDocument();
    // Before selecting, an edge1 interface (Eir) is visible.
    expect(screen.getByText('Eir PNI Dublin')).toBeInTheDocument();
    // Select edge2 → edge1 interfaces filtered out.
    fireEvent.click(edge2);
    expect(await screen.findByText(/Showing/)).toBeInTheDocument();
    expect(screen.queryByText('Eir PNI Dublin')).not.toBeInTheDocument();
  });

  it('an Engineer can edit an interface friendly name (persists via PUT)', async () => {
    stubApi(ENGINEER);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // The editable "Name" field is present for an Engineer.
    const inputs = screen.getAllByPlaceholderText('add name');
    expect(inputs.length).toBeGreaterThan(0);
    fireEvent.change(inputs[0], { target: { value: 'INEX Peering LAG' } });
    fireEvent.blur(inputs[0]);
    // The PUT carried the friendly name.
    const calls = (fetch as unknown as Mock).mock.calls;
    const put = calls.find((c) => String(c[0]).endsWith('/network/interfaces/label') && (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toMatchObject({ friendlyName: 'INEX Peering LAG' });
  });

  it('a NOC viewer sees friendly names read-only (no editable input)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    expect(screen.queryByPlaceholderText('add name')).not.toBeInTheDocument();
  });

  it('groups Port-Channel members per device (no cross-device merge)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Both routers have a Port-Channel7 with 1 member each — must read "1 member", never "2".
    expect(screen.getAllByText(/1 member/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/2 members/)).not.toBeInTheDocument();
    // The member renders (indented) under its Port-Channel.
    expect(screen.getByText('Transit member')).toBeInTheDocument();
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

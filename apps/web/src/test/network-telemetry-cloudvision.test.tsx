// Network Telemetry (CloudVision) page: renders summary, provider cards, interface + BGP
// tables from the mock API, shows the mock/informational provenance, and filters interfaces.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

// The main interface table (a description can also appear in the top-interfaces table now, so
// description-anchored assertions must be scoped to this one). Anchored on the "Link type"
// column header, which only the main interface table has.
const mainTable = (): HTMLElement => screen.getByRole('columnheader', { name: 'Link type' }).closest('table')! as HTMLElement;
// The top-interfaces table: the matrix-wrap that follows its section heading.
const topTable = (): HTMLElement =>
  screen.getByRole('heading', { name: /Top interfaces by bandwidth/ }).closest('.section-head')!.nextElementSibling!.querySelector('table')! as HTMLElement;

describe('Network Telemetry page', () => {
  it('shows summary, top interfaces, interfaces and BGP peers to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/network');

    // Wait for data-dependent content (the interface row) before synchronous assertions.
    expect(await screen.findByText('Eir PNI Dublin')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Network Telemetry', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('MOCK · SYNTHETIC')).toBeInTheDocument();
    expect(screen.getByText(/read-only and informational/i)).toBeInTheDocument();

    // Top-interfaces-by-bandwidth section renders (replaced the provider cards).
    expect(screen.getByRole('heading', { name: 'Top interfaces by bandwidth' })).toBeInTheDocument();

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
    expect(within(mainTable()).queryByText('Eir PNI Dublin')).not.toBeInTheDocument();
    expect(within(mainTable()).getByText('Transit Cogent')).toBeInTheDocument();
  });

  it('filters interfaces by router via the Router dropdown', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin'); // an edge1 interface
    fireEvent.change(screen.getAllByLabelText('Router')[0], { target: { value: 'JPE00000002' } }); // interface Router filter
    expect(within(mainTable()).queryByText('Eir PNI Dublin')).not.toBeInTheDocument(); // edge1 filtered out
    expect(within(mainTable()).getByText('Transit LAG')).toBeInTheDocument(); // edge2 interface remains
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

  it('hides idle ports (0 b/s in and out) when toggled', async () => {
    stubApi(NOC);
    renderAt('/network');
    // The idle port (no traffic) is visible by default.
    expect(await screen.findByText('Ethernet50')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Hide idle ports/));
    expect(screen.queryByText('Ethernet50')).not.toBeInTheDocument();
    // A port carrying traffic stays.
    expect(screen.getByText('Eir PNI Dublin')).toBeInTheDocument();
  });

  it('shows a live-read countdown pill', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Countdown to the next live read is present (auto-refresh is running).
    expect(screen.getByText(/next read in \d+s|reading…/)).toBeInTheDocument();
  });

  it('lists the top interfaces by bandwidth, busiest first', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin'); // wait for interface data to load
    const dataRows = within(topTable()).getAllByRole('row').slice(1); // drop the header row
    // Busiest by bandwidth first: edge1 Port-Channel7 (INEX LAG) at 128 Gb/s (members excluded).
    expect(within(dataRows[0]).getByText('INEX LAG')).toBeInTheDocument();
  });

  it('copies the top-interfaces table as an HTML table (with a plain-text fallback)', async () => {
    const captured: Record<string, Blob>[] = [];
    class FakeClipboardItem { constructor(public data: Record<string, Blob>) { captured.push(data); } }
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    expect(write).toHaveBeenCalledTimes(1);
    const item = captured[0];
    const html = await item['text/html'].text();
    expect(html).toContain('<table'); // a real table, not plain text
    expect(html).toContain('<th>Provider</th>');
    expect(html).toContain('INEX LAG'); // busiest link's description
    const tsv = await item['text/plain'].text();
    expect(tsv.split('\n')[0]).toBe('Router\tInterface\tDescription\tProvider\tCapacity\tCurrent\tUtil');
  });

  it('scopes the top-interfaces list to the Router filter', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Globally, edge1's Ethernet2 is among the busiest.
    expect(within(topTable()).getByText('Ethernet2')).toBeInTheDocument();
    // Select edge2 → the list follows, and edge1's Ethernet2 drops out.
    fireEvent.change(screen.getAllByLabelText('Router')[0], { target: { value: 'JPE00000002' } }); // interface Router filter
    expect(within(topTable()).queryByText('Ethernet2')).not.toBeInTheDocument();
  });

  it('colour-codes utilisation: amber ≥60% of capacity, red ≥80%, clear below', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Scope to each interface's ROW in the MAIN table (percentages also appear in the top table).
    const row = (desc: string) => within(within(mainTable()).getByText(desc).closest('tr')!);
    // INEX Ethernet2 is at 88% → red (crit).
    expect(row('INEX IXP Dublin').getByText('88.0%')).toHaveClass('util-crit');
    // edge1 Port-Channel7 is at 64% → amber (warn).
    expect(row('INEX LAG').getByText('64.0%')).toHaveClass('util-warn');
    // Eir Ethernet1 is at 40% → no colour.
    const eir = row('Eir PNI Dublin').getByText('40.0%');
    expect(eir).not.toHaveClass('util-warn');
    expect(eir).not.toHaveClass('util-crit');
  });

  it('correlates each BGP peer with the interface it runs on and shows the link load', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // The Eir peer (185.6.36.1) runs on Ethernet1 — its row shows the interface and its load.
    const peerRow = within(screen.getByText('185.6.36.1').closest('tr')!);
    expect(peerRow.getByText('Ethernet1')).toBeInTheDocument(); // interfaceId
    expect(peerRow.getByText(/Gb\/s · 40\.0%/)).toBeInTheDocument(); // correlated link load (current · util)
    expect(peerRow.getByText('IPv4')).toBeInTheDocument(); // active address families
  });

  it('filters BGP peers by provider and ASN', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    const bgpTable = () => screen.getByRole('columnheader', { name: 'Families' }).closest('table')! as HTMLElement;
    // Both peers visible initially (Eir 185.6.36.1, AS174 154.54.1.1).
    expect(within(bgpTable()).getByText('185.6.36.1')).toBeInTheDocument();
    // Filter by ASN 174 → only the AS174 peer remains.
    fireEvent.change(screen.getByLabelText('ASN'), { target: { value: '174' } });
    expect(within(bgpTable()).queryByText('185.6.36.1')).not.toBeInTheDocument(); // Eir is AS5466
    expect(within(bgpTable()).getByText('154.54.1.1')).toBeInTheDocument();
    // Clear ASN, filter by provider Eir → only the Eir peer remains.
    fireEvent.change(screen.getByLabelText('ASN'), { target: { value: '' } });
    fireEvent.change(screen.getAllByLabelText('Provider')[1], { target: { value: 'Eir' } }); // BGP Provider filter
    expect(within(bgpTable()).getByText('185.6.36.1')).toBeInTheDocument();
    expect(within(bgpTable()).queryByText('154.54.1.1')).not.toBeInTheDocument();
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

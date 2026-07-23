// Network Telemetry (CloudVision) page: renders summary, provider cards, interface + BGP
// tables from the mock API, shows the mock/informational provenance, and filters interfaces.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi, NETWORK_BGP_BODY } from './helpers';

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

    // Interface content + BGP grouped by provider (Eir, Cogent as distinct groups).
    expect(screen.getAllByText('down').length).toBeGreaterThan(0); // transit oper/status
    expect(within(bgpTable()).getByText('Cogent')).toBeInTheDocument(); // a BGP provider group
  });

  it('filters interfaces by link type', async () => {
    stubApi(VE);
    renderAt('/network');
    expect(await screen.findByText('Eir PNI Dublin')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Hide idle ports/)); // show idle/down interfaces (Transit Cogent is down)

    // Filter to TRANSIT only → Eir peering row disappears, transit remains.
    fireEvent.change(screen.getByLabelText('Link type'), { target: { value: 'TRANSIT' } });
    expect(within(mainTable()).queryByText('Eir PNI Dublin')).not.toBeInTheDocument();
    expect(within(mainTable()).getByText('Transit Cogent')).toBeInTheDocument();
  });

  it('filters interfaces by router via the Router dropdown', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin'); // an edge1 interface
    fireEvent.change(screen.getAllByLabelText('Device')[0], { target: { value: 'JPE00000002' } }); // interface Router filter
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

  it('shows both traffic directions in the Current cell (busier big, quieter small)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Each interface renders its busier direction with an "in"/"out" tag plus the quieter one beneath.
    const cells = document.querySelectorAll('.bw-cell');
    expect(cells.length).toBeGreaterThan(0);
    const first = cells[0];
    expect(first.querySelector('.bw-primary')).not.toBeNull();
    expect(first.querySelector('.bw-secondary')).not.toBeNull();
    // The mock is outbound-heavy, so the primary tag reads "out".
    expect(within(first as HTMLElement).getByText('out')).toBeInTheDocument();
  });

  it('splits devices into router/switch tabs and filters by datacentre', async () => {
    stubApi(NOC); // edge1 = router/Citywest, edge2 = switch/Parkwest
    renderAt('/network');
    // Both devices listed under the default "All" tab (device ids are unique to the Devices table).
    expect(await screen.findByText('JPE00000001')).toBeInTheDocument();
    expect(screen.getByText('JPE00000002')).toBeInTheDocument();
    // Switches tab → only the switch (edge2) remains; the router and its rows are scoped out.
    fireEvent.click(screen.getByRole('button', { name: /Switches/ }));
    expect(screen.queryByText('JPE00000001')).not.toBeInTheDocument();
    expect(screen.getByText('JPE00000002')).toBeInTheDocument();
    expect(screen.queryByText('Eir PNI Dublin')).not.toBeInTheDocument(); // an edge1 interface, scoped out
    // Back to All, then filter by datacentre = Citywest → only the router (edge1) remains.
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByLabelText('Datacentre'), { target: { value: 'Citywest' } });
    expect(screen.getByText('JPE00000001')).toBeInTheDocument();
    expect(screen.queryByText('JPE00000002')).not.toBeInTheDocument();
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

  it('hides idle ports (0 b/s in and out) by default; toggling off reveals them', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin'); // active port loads
    // The idle port (no traffic) is hidden by default.
    expect(screen.queryByText('Ethernet50')).not.toBeInTheDocument();
    // Toggle the filter off → idle port appears.
    fireEvent.click(screen.getByLabelText(/Hide idle ports/));
    expect(screen.getByText('Ethernet50')).toBeInTheDocument();
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
    fireEvent.change(screen.getAllByLabelText('Device')[0], { target: { value: 'JPE00000002' } }); // interface Router filter
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

  const bgpTable = () => screen.getByRole('columnheader', { name: 'Connection' }).closest('table')! as HTMLElement;

  it('groups BGP by provider and expands to show sessions with connection type + link load', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Eir is one provider group showing its dedicated PNI (connection type).
    expect(within(bgpTable()).getByText('Eir')).toBeInTheDocument();
    expect(within(bgpTable()).getByText('PNI')).toBeInTheDocument();
    // Individual sessions are hidden until the group is expanded.
    expect(within(bgpTable()).queryByText('185.6.36.1')).not.toBeInTheDocument();
    fireEvent.click(within(bgpTable()).getByText('Eir'));
    // Expanded → the two sessions appear; the correlated interface load shows on the session row.
    const peerRow = within(within(bgpTable()).getByText('185.6.36.1').closest('tr')!);
    expect(peerRow.getByText(/Gb\/s · 40\.0%/)).toBeInTheDocument();
  });

  it('fails open: peers still show when the API response has no role field (legacy API)', async () => {
    // Simulate an API that predates the `role` field — every peer's role is undefined.
    const legacy = { ...NETWORK_BGP_BODY, items: NETWORK_BGP_BODY.items.map((it) => { const copy: Record<string, unknown> = { ...it }; delete copy.role; return copy; }) };
    stubApi(NOC, { bgpBody: legacy });
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // An unknown role must be treated as delivery — the provider groups must NOT vanish.
    expect(within(bgpTable()).getByText('Eir')).toBeInTheDocument();
    expect(within(bgpTable()).getByText('Cogent')).toBeInTheDocument();
    expect(within(bgpTable()).queryByText('No BGP peers.')).not.toBeInTheDocument();
  });

  it('excludes route-collector sessions from the delivery view and notes the hidden count', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // The [RC] INEX route-collector session is a delivery non-participant: it must not appear as
    // a provider group, and it must not be exposed as a Provider filter option.
    expect(within(bgpTable()).queryByText('185.6.36.8')).not.toBeInTheDocument();
    expect(within(bgpTable()).queryByText('Route collector')).not.toBeInTheDocument();
    // But it is surfaced as a hidden-count note (nothing is silently dropped).
    expect(screen.getByText(/1 route-collector session hidden/i)).toBeInTheDocument();
  });

  it('filters BGP groups by provider and ASN', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // Both provider groups initially (Eir, Cogent).
    expect(within(bgpTable()).getByText('Eir')).toBeInTheDocument();
    expect(within(bgpTable()).getByText('Cogent')).toBeInTheDocument();
    // Filter by ASN 174 → only the Cogent (AS174) group remains.
    fireEvent.change(screen.getByLabelText('ASN'), { target: { value: '174' } });
    expect(within(bgpTable()).queryByText('Eir')).not.toBeInTheDocument();
    expect(within(bgpTable()).getByText('Cogent')).toBeInTheDocument();
    // Clear ASN, filter by provider Eir → only the Eir group.
    fireEvent.change(screen.getByLabelText('ASN'), { target: { value: '' } });
    fireEvent.change(screen.getAllByLabelText('Provider')[1], { target: { value: 'Eir' } }); // BGP Provider filter
    expect(within(bgpTable()).getByText('Eir')).toBeInTheDocument();
    expect(within(bgpTable()).queryByText('Cogent')).not.toBeInTheDocument();
  });

  it('lists configured peering capacity per link inside the Peering tile (LAG members excluded)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    const tile = within(screen.getByText('Peering').closest('.card')! as HTMLElement);
    // Marked as configured capacity — not the live throughput shown above it.
    expect(tile.getByText(/Configured capacity by link/i)).toBeInTheDocument();
    // Two peering links, LAG members excluded: Port-Channel7 (200 Gb/s) + Ethernet2 (100 Gb/s).
    expect(tile.getByText('Po7')).toBeInTheDocument();
    expect(tile.getByText('Et2')).toBeInTheDocument();
    expect(tile.getByText('200 Gb/s')).toBeInTheDocument();
    // The Eir member (Ethernet1 in Port-Channel7) is excluded — no member row.
    expect(tile.queryByText('Et1')).not.toBeInTheDocument();
    // Total configured capacity = 200 + 100 = 300 Gb/s, distinct from the 110 Gb/s live stat above.
    expect(tile.getByText('Total capacity')).toBeInTheDocument();
    expect(tile.getByText('300 Gb/s')).toBeInTheDocument();
    expect(tile.getByText('110 Gb/s')).toBeInTheDocument(); // the live peering throughput
  });

  it('lists configured transit capacity per link inside the Transit tile (LAG members excluded)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('Eir PNI Dublin');
    // "Transit" also appears as a provider/description, so anchor on the tile label (.muted div).
    const tile = within(screen.getByText('Transit', { selector: '.muted' }).closest('.card')! as HTMLElement);
    expect(tile.getByText(/Configured capacity by link/i)).toBeInTheDocument();
    // Two transit links, LAG members excluded: edge1 Ethernet4 (100 Gb/s) + edge2 Port-Channel7 (100 Gb/s).
    expect(tile.getByText('Et4')).toBeInTheDocument();
    expect(tile.getByText('Po7')).toBeInTheDocument();
    // The transit member (Ethernet9 in edge2 Port-Channel7) is excluded — no member row.
    expect(tile.queryByText('Et9')).not.toBeInTheDocument();
    // Total configured capacity = 100 + 100 = 200 Gb/s, distinct from the 20 Gb/s live stat above.
    expect(tile.getByText('Total capacity')).toBeInTheDocument();
    expect(tile.getByText('200 Gb/s')).toBeInTheDocument();
    expect(tile.getByText('20 Gb/s')).toBeInTheDocument(); // the live transit throughput
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

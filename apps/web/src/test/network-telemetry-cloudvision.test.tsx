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
  screen.getByRole('heading', { name: /Top interfaces by utilisation/ }).closest('.section-head')!.nextElementSibling!.querySelector('table')! as HTMLElement;

describe('Network Telemetry page', () => {
  it('shows summary, top interfaces, interfaces and BGP peers to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/network');

    // Wait for data-dependent content (the interface row) before synchronous assertions.
    expect(await screen.findByText('JPE00000001')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Network Telemetry', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('MOCK · SYNTHETIC')).toBeInTheDocument();

    // Top-interfaces-by-utilisation section renders (replaced the provider cards).
    expect(screen.getByRole('heading', { name: 'Top interfaces by utilisation' })).toBeInTheDocument();

    // Interface content + BGP grouped by provider (Eir, Cogent as distinct groups).
    expect(screen.getAllByText('down').length).toBeGreaterThan(0); // transit oper/status
    expect(within(bgpTable()).getByText('Cogent')).toBeInTheDocument(); // a BGP provider group
  });

  it('filters interfaces by link type', async () => {
    stubApi(VE);
    renderAt('/network');
    expect(await screen.findByText('JPE00000001')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Hide idle ports/)); // show idle/down interfaces (Transit Cogent is down)

    // Filter to TRANSIT only → the IX peering row disappears, transit remains.
    fireEvent.change(screen.getByLabelText('Link type'), { target: { value: 'TRANSIT' } });
    expect(within(mainTable()).queryByText('INEX IXP Dublin')).not.toBeInTheDocument();
    expect(within(mainTable()).getByText('Transit Cogent')).toBeInTheDocument();
  });

  it('filters interfaces by router via the Router dropdown', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001'); // an edge1 device
    fireEvent.change(screen.getAllByLabelText('Device')[0], { target: { value: 'JPE00000002' } }); // interface Router filter
    expect(within(mainTable()).queryByText('INEX IXP Dublin')).not.toBeInTheDocument(); // edge1 interface filtered out
    expect(within(mainTable()).getByText('Transit LAG')).toBeInTheDocument(); // edge2 interface remains
  });

  it('lists devices and drills into one to filter interfaces + BGP', async () => {
    stubApi(NOC);
    renderAt('/network');
    // Select edge2 by its device id (unique to the Devices table).
    const edge2 = await screen.findByText('JPE00000002');
    expect(screen.getByRole('heading', { name: /Devices/ })).toBeInTheDocument();
    // Before selecting, an edge1 interface (INEX IXP) is visible in the interfaces table.
    expect(within(mainTable()).getByText('INEX IXP Dublin')).toBeInTheDocument();
    // Select edge2 → edge1 interfaces filtered out.
    fireEvent.click(edge2);
    expect(await screen.findByText(/Showing/)).toBeInTheDocument();
    expect(within(mainTable()).queryByText('INEX IXP Dublin')).not.toBeInTheDocument();
  });

  it('shows both traffic directions in the Current cell (busier big, quieter small)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    // Each interface renders its busier direction with an "in"/"out" tag plus the quieter one beneath.
    const cells = document.querySelectorAll('.bw-cell');
    expect(cells.length).toBeGreaterThan(0);
    const first = cells[0];
    expect(first.querySelector('.bw-primary')).not.toBeNull();
    expect(first.querySelector('.bw-secondary')).not.toBeNull();
    // The mock is outbound-heavy, so the primary tag reads "out".
    expect(within(first as HTMLElement).getByText('out')).toBeInTheDocument();
  });

  it('splits devices by type tab and filters by datacentre', async () => {
    stubApi(NOC); // edge1 = router/Citywest, edge2 = router/Parkwest
    renderAt('/network');
    // Both devices listed under the default "All" tab (device ids are unique to the Devices table).
    expect(await screen.findByText('JPE00000001')).toBeInTheDocument();
    expect(screen.getByText('JPE00000002')).toBeInTheDocument();
    // Routers tab → both remain (both are edge routers).
    fireEvent.click(screen.getByRole('button', { name: /Routers/ }));
    expect(screen.getByText('JPE00000001')).toBeInTheDocument();
    expect(screen.getByText('JPE00000002')).toBeInTheDocument();
    // Switches tab → none (no switch in this mock) and the router interfaces are scoped out.
    fireEvent.click(screen.getByRole('button', { name: /Switches/ }));
    expect(screen.queryByText('JPE00000001')).not.toBeInTheDocument();
    expect(screen.queryByText('JPE00000002')).not.toBeInTheDocument();
    expect(screen.queryByText('INEX IXP Dublin')).not.toBeInTheDocument();
    // Back to All, then filter by datacentre = Citywest → only edge1 (Parkwest edge2 drops out).
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByLabelText('Datacentre'), { target: { value: 'Citywest' } });
    expect(screen.getByText('JPE00000001')).toBeInTheDocument();
    expect(screen.queryByText('JPE00000002')).not.toBeInTheDocument();
  });

  it('groups Port-Channel members per device (no cross-device merge), collapsed by default', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    // Both routers have a Port-Channel7 with 1 member each — must read "1 member", never "2".
    expect(screen.getAllByText(/1 member/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/2 members/)).not.toBeInTheDocument();
    // Port-Channels are collapsed by default: the member is hidden until the row is expanded.
    expect(screen.queryByText('Transit member')).not.toBeInTheDocument();
    const lagRow = within(mainTable()).getByText('Transit LAG').closest('tr')! as HTMLElement;
    fireEvent.click(within(lagRow).getByRole('button', { name: 'expand' }));
    // Now the member renders (indented) under its Port-Channel.
    expect(screen.getByText('Transit member')).toBeInTheDocument();
  });

  it('hides idle ports (0 b/s in and out) by default; toggling off reveals them', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001'); // active port loads
    // The idle port (no traffic) is hidden by default.
    expect(screen.queryByText('Ethernet50')).not.toBeInTheDocument();
    // Toggle the filter off → idle port appears.
    fireEvent.click(screen.getByLabelText(/Hide idle ports/));
    expect(screen.getByText('Ethernet50')).toBeInTheDocument();
  });

  it('shows a live-read countdown pill', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    // Countdown to the next live read is present (auto-refresh is running).
    expect(screen.getByText(/next read in \d+s|reading…/)).toBeInTheDocument();
  });

  it('lists the top interfaces by utilisation, hottest first', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001'); // wait for interface data to load
    const dataRows = within(topTable()).getAllByRole('row').slice(1); // drop the header row
    // Most-utilised first: edge1 Ethernet2 (INEX IXP Dublin) at 88% beats the INEX LAG's 128 Gb/s
    // (which is only 64% of its 200G) — ranking by % utilisation, not absolute bandwidth.
    expect(within(dataRows[0]).getByText('INEX IXP Dublin')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('INEX LAG')).toBeInTheDocument();
  });

  it('copies the top-interfaces table as an HTML table (with a plain-text fallback)', async () => {
    const captured: Record<string, Blob>[] = [];
    class FakeClipboardItem { constructor(public data: Record<string, Blob>) { captured.push(data); } }
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    expect(write).toHaveBeenCalledTimes(1);
    const item = captured[0];
    const html = await item['text/html'].text();
    expect(html).toContain('<table'); // a real table, not plain text
    expect(html).toContain('<th>Provider</th>');
    expect(html).toContain('INEX LAG'); // a top-utilised link's description (still in the top list)
    const tsv = await item['text/plain'].text();
    expect(tsv.split('\n')[0]).toBe('Router\tInterface\tDescription\tProvider\tCapacity\tCurrent\tUtil');
  });

  it('scopes the top-interfaces list to the Router filter', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    // Globally, edge1's Ethernet2 is the most utilised (88%).
    expect(within(topTable()).getByText('Ethernet2')).toBeInTheDocument();
    // Select edge2 → the list follows, and edge1's Ethernet2 drops out.
    fireEvent.change(screen.getAllByLabelText('Device')[0], { target: { value: 'JPE00000002' } }); // interface Router filter
    expect(within(topTable()).queryByText('Ethernet2')).not.toBeInTheDocument();
  });

  it('colour-codes utilisation: amber ≥60% of capacity, red ≥80%, clear below', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    // Scope to each interface's ROW in the MAIN table (percentages also appear in the top table).
    const row = (desc: string) => within(within(mainTable()).getByText(desc).closest('tr')!);
    // INEX Ethernet2 is at 88% → red (crit).
    expect(row('INEX IXP Dublin').getByText('88.0%')).toHaveClass('util-crit');
    // edge1 Port-Channel7 is at 64% → amber (warn).
    expect(row('INEX LAG').getByText('64.0%')).toHaveClass('util-warn');
    // Transit LAG (edge2 Port-Channel7) is at 30% → no colour.
    const low = row('Transit LAG').getByText('30.0%');
    expect(low).not.toHaveClass('util-warn');
    expect(low).not.toHaveClass('util-crit');
  });

  const bgpTable = () => screen.getByRole('columnheader', { name: 'Connection' }).closest('table')! as HTMLElement;

  it('groups BGP by provider and expands to show sessions with connection type + link load', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
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
    await screen.findByText('JPE00000001');
    // An unknown role must be treated as delivery — the provider groups must NOT vanish.
    expect(within(bgpTable()).getByText('Eir')).toBeInTheDocument();
    expect(within(bgpTable()).getByText('Cogent')).toBeInTheDocument();
    expect(within(bgpTable()).queryByText('No BGP peers.')).not.toBeInTheDocument();
  });

  it('excludes route-collector sessions from the delivery view and notes the hidden count', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
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
    await screen.findByText('JPE00000001');
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

  it('lists EYEBALL peering capacity grouped by provider in a stable order (IX excluded)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    const panel = within(screen.getByRole('heading', { name: 'Peering capacity' }).closest('.card')! as HTMLElement);
    expect(panel.getByText(/Configured capacity by provider/i)).toBeInTheDocument();
    // Eir and Sky each have a PNI on both edge routers → grouped as "2× 100 Gb/s" per provider.
    expect(within(panel.getByText('Eir').closest('.tile-list-row')! as HTMLElement).getByText('2× 100 Gb/s')).toBeInTheDocument();
    expect(within(panel.getByText('Sky').closest('.tile-list-row')! as HTMLElement).getByText('2× 100 Gb/s')).toBeInTheDocument();
    // INEX is IX peering, not eyeball → excluded entirely from the peering capacity panel.
    expect(panel.queryByText('INEX')).not.toBeInTheDocument();
    // Total eyeball peering capacity = 4 × 100 Gb/s.
    expect(panel.getByText('Total capacity')).toBeInTheDocument();
    expect(panel.getByText('400 Gb/s')).toBeInTheDocument();
    // The live peering throughput (110 Gb/s) is the KPI tile, separate from the capacity panel.
    const kpi = within(screen.getByText('Peering').closest('.card')! as HTMLElement);
    expect(kpi.getByText('110 Gb/s')).toBeInTheDocument();
  });

  it('lists transit capacity grouped by provider (LAG members excluded)', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    const panel = within(screen.getByRole('heading', { name: 'Transit capacity' }).closest('.card')! as HTMLElement);
    expect(panel.getByText(/Configured capacity by provider/i)).toBeInTheDocument();
    // Two transit links (edge1 Ethernet4 + edge2 Port-Channel7), both provider "Transit", each 100 Gb/s.
    expect(within(panel.getByText('Transit').closest('.tile-list-row')! as HTMLElement).getByText('2× 100 Gb/s')).toBeInTheDocument();
    // The transit member (Ethernet9 in edge2 Port-Channel7) is excluded — not double-counted.
    expect(panel.getByText('Total capacity')).toBeInTheDocument();
    expect(panel.getByText('200 Gb/s')).toBeInTheDocument();
    // The live transit throughput (20 Gb/s) is the KPI tile, separate from the capacity panel.
    const kpi = within(screen.getByText('Transit', { selector: '.muted' }).closest('.card')! as HTMLElement);
    expect(kpi.getByText('20 Gb/s')).toBeInTheDocument();
  });

  it('summary tiles reflect the connector snapshot', async () => {
    stubApi(NOC);
    renderAt('/network');
    // Await data before reading the (data-dependent) tile value.
    await screen.findByText('JPE00000001');
    const tile = screen.getByText('Unhealthy links').closest('.card')! as HTMLElement;
    expect(within(tile).getByText('1')).toBeInTheDocument();
  });

  it('opens the PNI Graphs tab: grouped/collapsible key, day + range selectors, eyeball default', async () => {
    stubApi(NOC);
    renderAt('/network');
    await screen.findByText('JPE00000001');
    fireEvent.click(screen.getByRole('button', { name: 'PNI / Interface Graphs' }));

    // The key is grouped by role, and groups are COLLAPSED by default — chips are hidden until opened.
    await screen.findByRole('button', { name: /Eyeball PNI/ });
    expect(screen.queryByText('Eir CTW Po7')).not.toBeInTheDocument();
    // The chart is a real time-series (SVG) labelled by direction + range.
    expect(screen.getByRole('img', { name: /PNI .*bandwidth over the last 60 minutes/ })).toBeInTheDocument();
    // Range selector present with the 1-hour default active; day selector spans the last 7 days, live.
    expect(screen.getByRole('button', { name: '1h' }).className).toContain('active');
    const daySel = screen.getByRole('combobox', { name: 'Day' }) as HTMLSelectElement;
    expect(daySel.options).toHaveLength(7);
    expect(daySel.value).toBe('0');

    // Expand the Eyeball PNI and Transit groups to inspect their chips.
    fireEvent.click(screen.getByRole('button', { name: /Eyeball PNI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Transit \(/ }));
    expect(screen.getByText('Eir CTW Po7')).toBeInTheDocument();
    expect(screen.getByText('Sky CTW Po4')).toBeInTheDocument();
    expect(screen.queryByText(/Et8\/3\/1/)).not.toBeInTheDocument(); // stray unresolved LAG member filtered out

    // ALL links are logged, but non-eyeball ones (transit Cogent) start HIDDEN by default.
    const cogent = () => screen.getByText('Cogent PKW Et4').closest('button')!;
    expect(cogent().className).toContain('off');
    // An eyeball link whose link_type is still null is classified by provider → shown by default.
    expect(screen.getByText('Vodafone PKW Po9').closest('button')!.className).not.toContain('off');
    // Eyeball networks are listed FIRST in the key.
    const chips = screen.getAllByText(/(CTW|PKW) (Et|Po)/).map((el) => el.textContent);
    expect(chips.indexOf('Eir CTW Po7')).toBeLessThan(chips.indexOf('Cogent PKW Et4'));

    // "All" reveals the transit link; the "Eyeball" button hides the non-eyeball links again.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(cogent().className).not.toContain('off');
    fireEvent.click(screen.getByRole('button', { name: 'Eyeball' }));
    expect(cogent().className).toContain('off');

    // Selecting a past day pauses live-follow (a "Live" button appears to return to now).
    fireEvent.change(daySel, { target: { value: '2' } });
    expect(screen.getByRole('button', { name: /Live/ })).toBeInTheDocument();

    // The legend doubles as a PNI filter — clicking a chip toggles that series off.
    fireEvent.click(screen.getByText('Eir CTW Po7'));
    expect(screen.getByText('Eir CTW Po7').closest('button')!.className).toContain('off');
  });
});

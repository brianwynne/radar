import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DcBandwidth } from '../features/DcBandwidth';
import type { NetworkInterface } from '../api/types';

afterEach(() => vi.unstubAllGlobals());

const CW = 'JPN2508A7QM'; // Citywest edge serial
const PW = 'JPA2430A9R2'; // Parkwest edge serial
const G = 1e9;

const itf = (deviceId: string, name: string, provider: string, linkType: string, primaryBps: number, speedBps = 100 * G): NetworkInterface =>
  ({ deviceId, name, provider, linkType, memberOf: null, primaryBps, speedBps, utilisationPercent: speedBps ? (primaryBps / speedBps) * 100 : null } as unknown as NetworkInterface);

describe('DcBandwidth', () => {
  const interfaces: NetworkInterface[] = [
    itf(CW, 'Port-Channel7', 'Eir', 'PRIVATE_PEERING', 40 * G),
    itf(CW, 'Port-Channel4', 'Sky', 'PRIVATE_PEERING', 60 * G),
    itf(CW, 'Port-Channel1', 'INEX', 'IX_PEERING', 30 * G),
    itf(PW, 'Port-Channel7', 'Eir', 'PRIVATE_PEERING', 90 * G),
    itf(PW, 'Port-Channel3', 'Liberty', 'PRIVATE_PEERING', 50 * G),
    itf(CW, 'Ethernet9', 'Cogent', 'TRANSIT', 99 * G), // transit — must be ignored
    itf(CW, 'Port-Channel9', 'Microsoft', 'PRIVATE_PEERING', 70 * G), // a PNI, but cloud peering — must be excluded
    itf(CW, 'Port-Channel50', 'edge-citywest-switch', 'PRIVATE_PEERING', 200 * G), // router↔switch uplink — must be excluded
    itf(CW, 'Port-Channel30', 'Core', 'PRIVATE_PEERING', 150 * G), // inter-DC/core link — must be excluded
  ];

  it('shows Citywest and Parkwest total delivery bandwidth (PNI + IX)', () => {
    render(<DcBandwidth interfaces={interfaces} />);
    const cw = screen.getByText('Citywest total').closest('.card')! as HTMLElement;
    expect(within(cw).getByText('130.0')).toBeInTheDocument(); // 40 + 60 + 30
    const pw = screen.getByText('Parkwest total').closest('.card')! as HTMLElement;
    expect(within(pw).getByText('140.0')).toBeInTheDocument(); // 90 + 50
  });

  it('lists each PNI with its realtime bandwidth and the PNI total', () => {
    render(<DcBandwidth interfaces={interfaces} />);
    // Each PNI row in the detail table (Eir appears at both DCs).
    const detail = screen.getByText('Datacentre').closest('table')! as HTMLElement;
    expect(within(detail).getAllByText('Eir').length).toBe(2);
    expect(within(detail).getByText('Sky')).toBeInTheDocument();
    expect(within(detail).getByText('Liberty')).toBeInTheDocument();
    // Total of PNIs = 40 + 60 + 90 + 50 = 240 (excludes the 30 IX and the transit link).
    const totalRow = screen.getByText('Total of PNIs').closest('tr')! as HTMLElement;
    expect(within(totalRow).getByText('240.0 Gb/s')).toBeInTheDocument();
  });

  it('lists eyeball ISPs only — excludes transit, cloud peers, router uplinks and core links', () => {
    render(<DcBandwidth interfaces={interfaces} />);
    expect(screen.queryByText('Cogent')).not.toBeInTheDocument(); // transit
    expect(screen.queryByText('Microsoft')).not.toBeInTheDocument(); // cloud peer
    expect(screen.queryByText('edge-citywest-switch')).not.toBeInTheDocument(); // router↔switch uplink
    expect(screen.queryByText('Core')).not.toBeInTheDocument(); // inter-DC / core
  });

  it('shows capacity and the amber/red utilisation alert per link (same as the main page)', () => {
    // A link at 85% of its 100G capacity → red (util-crit).
    render(<DcBandwidth interfaces={[itf(CW, 'Port-Channel3', 'Liberty', 'PRIVATE_PEERING', 85 * G, 100 * G)]} />);
    const detail = screen.getByText('Datacentre').closest('table')! as HTMLElement;
    const row = within(detail).getByText('Liberty').closest('tr')! as HTMLElement;
    expect(within(row).getByText('100.0 Gb/s')).toBeInTheDocument(); // capacity
    const util = within(row).getByText(/85%/);
    expect(util.closest('td')).toHaveClass('util-crit'); // red alert at ≥80%
  });

  it('shows the % difference between paired links (same provider at both DCs)', () => {
    render(<DcBandwidth interfaces={interfaces} />);
    // Eir is the only provider present at BOTH DCs (Citywest 40G, Parkwest 90G).
    const pairsTable = screen.getByText('Paired link').closest('table')! as HTMLElement;
    const eirRow = within(pairsTable).getByText('Eir').closest('tr')! as HTMLElement;
    expect(within(eirRow).getByText('40.0 G')).toBeInTheDocument();
    expect(within(eirRow).getByText('90.0 G')).toBeInTheDocument();
    expect(within(eirRow).getByText(/PW \+56%/)).toBeInTheDocument(); // (90-40)/90 ≈ 55.6% of the larger side
    // Single-homed links (Sky CW-only, Liberty PW-only) are not pairs.
    expect(within(pairsTable).queryByText('Sky')).not.toBeInTheDocument();
    expect(within(pairsTable).queryByText('Liberty')).not.toBeInTheDocument();
  });

  it('accumulates a difference-trend sparkline across polls', () => {
    const poll1: NetworkInterface[] = [itf(CW, 'PC7', 'Eir', 'PRIVATE_PEERING', 40 * G), itf(PW, 'PC7', 'Eir', 'PRIVATE_PEERING', 90 * G)];
    const poll2: NetworkInterface[] = [itf(CW, 'PC7', 'Eir', 'PRIVATE_PEERING', 60 * G), itf(PW, 'PC7', 'Eir', 'PRIVATE_PEERING', 90 * G)];
    const { rerender } = render(<DcBandwidth interfaces={poll1} />);
    rerender(<DcBandwidth interfaces={poll2} />); // second poll → ≥2 points → the sparkline draws
    const eirRow = within(screen.getByText('Paired link').closest('table')! as HTMLElement).getByText('Eir').closest('tr')! as HTMLElement;
    expect(within(eirRow).getByRole('img', { name: /difference trend/i })).toBeInTheDocument();
  });

  it('seeds the trend from backend history so it is populated on first access', async () => {
    // Backend history: Eir CW/PW over three prior samples → the sparkline draws immediately (no waiting).
    const G = 1e9;
    const ottHistory = { count: 3, items: [
      { at: 't1', byProvider: { Eir: { citywest: 40 * G, parkwest: 90 * G } } },
      { at: 't2', byProvider: { Eir: { citywest: 55 * G, parkwest: 90 * G } } },
      { at: 't3', byProvider: { Eir: { citywest: 70 * G, parkwest: 90 * G } } },
    ] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes('/network/ott-history') ? ottHistory : {}), { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<DcBandwidth interfaces={[itf(CW, 'PC7', 'Eir', 'PRIVATE_PEERING', 70 * G), itf(PW, 'PC7', 'Eir', 'PRIVATE_PEERING', 90 * G)]} />);
    const eirRow = within(await screen.findByText('Paired link').then((el) => el.closest('table')! as HTMLElement)).getByText('Eir').closest('tr')! as HTMLElement;
    // ≥2 seeded points → the sparkline (not "collecting…") is present right away.
    expect(await within(eirRow).findByRole('img', { name: /difference trend/i })).toBeInTheDocument();
  });

  it('a pair with traffic on only one DC reads 100% difference', () => {
    const oneSided: NetworkInterface[] = [
      itf(CW, 'Port-Channel5', 'Three', 'PRIVATE_PEERING', 1.5 * G),
      itf(PW, 'Port-Channel5', 'Three', 'PRIVATE_PEERING', 0), // dead PNI at Parkwest
    ];
    render(<DcBandwidth interfaces={oneSided} />);
    const pairsTable = screen.getByText('Paired link').closest('table')! as HTMLElement;
    const row = within(pairsTable).getByText('Three').closest('tr')! as HTMLElement;
    expect(within(row).getByText(/CW \+100%/)).toBeInTheDocument(); // 1.5 vs 0 ⇒ 100%, not 200%
  });

  it('the focus filter scopes the per-PNI list and totals to one datacentre', async () => {
    render(<DcBandwidth interfaces={interfaces} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Citywest' }));
    expect(screen.queryByText('Liberty')).not.toBeInTheDocument(); // Parkwest link is filtered out
    expect(screen.getByText('Sky')).toBeInTheDocument();
    // Citywest PNIs only: Eir 40 + Sky 60 = 100 (Microsoft still excluded).
    const totalRow = screen.getByText('Total of PNIs').closest('tr')! as HTMLElement;
    expect(within(totalRow).getByText('100.0 Gb/s')).toBeInTheDocument();
  });

  it('excludes a non-delivery cloud peer (Microsoft) even though it is a PNI', () => {
    render(<DcBandwidth interfaces={interfaces} />);
    expect(screen.queryByText('Microsoft')).not.toBeInTheDocument();
    // Its 70G must not be counted in Citywest total (still 130) or the PNI total (still 240).
    const cw = screen.getByText('Citywest total').closest('.card')! as HTMLElement;
    expect(within(cw).getByText('130.0')).toBeInTheDocument();
    const totalRow = screen.getByText('Total of PNIs').closest('tr')! as HTMLElement;
    expect(within(totalRow).getByText('240.0 Gb/s')).toBeInTheDocument();
  });
});

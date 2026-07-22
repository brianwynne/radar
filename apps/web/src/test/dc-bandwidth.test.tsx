import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DcBandwidth } from '../features/DcBandwidth';
import type { NetworkInterface } from '../api/types';

const CW = 'JPN2508A7QM'; // Citywest edge serial
const PW = 'JPA2430A9R2'; // Parkwest edge serial
const G = 1e9;

const itf = (deviceId: string, name: string, provider: string, linkType: string, primaryBps: number): NetworkInterface =>
  ({ deviceId, name, provider, linkType, memberOf: null, primaryBps } as unknown as NetworkInterface);

describe('DcBandwidth', () => {
  const interfaces: NetworkInterface[] = [
    itf(CW, 'Port-Channel7', 'Eir', 'PRIVATE_PEERING', 40 * G),
    itf(CW, 'Port-Channel4', 'Sky', 'PRIVATE_PEERING', 60 * G),
    itf(CW, 'Port-Channel1', 'INEX', 'IX_PEERING', 30 * G),
    itf(PW, 'Port-Channel7', 'Eir', 'PRIVATE_PEERING', 90 * G),
    itf(PW, 'Port-Channel3', 'Liberty', 'PRIVATE_PEERING', 50 * G),
    itf(CW, 'Ethernet9', 'Cogent', 'TRANSIT', 99 * G), // transit — must be ignored
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
    // Each PNI row (Eir appears at both DCs).
    expect(screen.getAllByText('Eir').length).toBe(2);
    expect(screen.getByText('Sky')).toBeInTheDocument();
    expect(screen.getByText('Liberty')).toBeInTheDocument();
    // Total of PNIs = 40 + 60 + 90 + 50 = 240 (excludes the 30 IX and the transit link).
    const totalRow = screen.getByText('Total of PNIs').closest('tr')! as HTMLElement;
    expect(within(totalRow).getByText('240.0 Gb/s')).toBeInTheDocument();
  });

  it('ignores non-delivery (transit) links', () => {
    render(<DcBandwidth interfaces={interfaces} />);
    expect(screen.queryByText('Cogent')).not.toBeInTheDocument();
  });
});

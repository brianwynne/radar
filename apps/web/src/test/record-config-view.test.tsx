import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordConfigView } from '../features/RecordConfigView';

const RECORD = {
  ttl: 180,
  use_client_subnet: true,
  answers: [
    { id: 'a1', answer: ['liveedge.rte.ie'], meta: { weight: 400, note: 'Main RTE CDN', asn: [5466, 15502] } },
    { id: 'a2', answer: ['t.sni.global.fastly.net'], meta: { weight: 40, note: 'Fastly overflow' } },
    { id: 'a3', answer: ['live.rte.ie.akamaized.net'], meta: { weight: 200, country: ['IE', 'GB'] } },
  ],
  filters: [{ filter: 'netfence_asn' }, { filter: 'weighted_shuffle' }, { filter: 'select_first_n', config: { N: 1 } }],
};

const renderView = () => render(<RecordConfigView record={RECORD} zone="nsone.rte.ie" domain="live.rte.ie" type="CNAME" />);

describe('RecordConfigView', () => {
  it('groups answers by derived delivery platform', () => {
    renderView();
    expect(screen.getByText('Réalta')).toBeInTheDocument();
    expect(screen.getByText('Fastly')).toBeInTheDocument();
    expect(screen.getByText('Akamai')).toBeInTheDocument();
    expect(screen.getByText('liveedge.rte.ie')).toBeInTheDocument();
    expect(screen.getByText('Main RTE CDN')).toBeInTheDocument();
  });

  it('explains the filter chain in plain language, in order', () => {
    renderView();
    expect(screen.getByText('Netfence ASN')).toBeInTheDocument();
    expect(screen.getByText('Weighted Shuffle')).toBeInTheDocument();
    expect(screen.getByText(/Select First N · N=1/)).toBeInTheDocument();
    // RADAR's summary is shown by default (not NS1's long text).
    expect(screen.getByText(/asn list includes the requester's AS/i)).toBeInTheDocument();
  });

  it("reveals NS1's own verbatim description on 'details', and reads the remove-untagged flag", async () => {
    renderView();
    const step = screen.getByText('Netfence ASN').closest('.filter-step') as HTMLElement;
    // Flag state is read from the (empty) config → off.
    expect(within(step).getByText(/remove untagged: off/i)).toBeInTheDocument();
    // NS1's long text is hidden until expanded.
    expect(within(step).queryByText(/Autonomous System \(AS\)/)).toBeNull();
    await userEvent.click(within(step).getByRole('button', { name: /details/i }));
    expect(within(step).getByText(/NS1's description/i)).toBeInTheDocument();
    expect(within(step).getByText(/Autonomous System \(AS\) of the requester/i)).toBeInTheDocument();
  });

  it('translates country codes to names', () => {
    renderView();
    // Two codes → shown as names directly.
    expect(screen.getByText('Ireland, United Kingdom')).toBeInTheDocument();
  });

  it('shows weight and offers ASN owner resolution when answers carry ASNs', () => {
    renderView();
    const realta = screen.getByText('liveedge.rte.ie').closest('.answer-card') as HTMLElement;
    expect(within(realta).getByText('400')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resolve network owners/i })).toBeInTheDocument();
  });

  it('expands an answer\'s ASN list showing the raw AS numbers', async () => {
    renderView();
    const realta = screen.getByText('liveedge.rte.ie').closest('.answer-card') as HTMLElement;
    await userEvent.click(within(realta).getByRole('button', { name: /^show$/i }));
    expect(within(realta).getByText(/AS5466/)).toBeInTheDocument();
    expect(within(realta).getByText(/AS15502/)).toBeInTheDocument();
  });
});

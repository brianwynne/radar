// Stream Assurance page: profile list, CDN comparison table and the origin-variant finding; the
// Run-now action is gated to a viewing engineer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Stream Assurance page', () => {
  it('shows the CDN comparison and the origin-variant finding to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/stream-assurance');
    expect(await screen.findByRole('heading', { name: 'Stream Assurance', level: 1 })).toBeInTheDocument();

    // Latest run loads for the default-selected profile → the incident finding is shown.
    expect(await screen.findByText('ORIGIN_VARIANT_MISMATCH')).toBeInTheDocument();
    expect(screen.getByText('SA-CDN-001')).toBeInTheDocument();
    expect(screen.getByText(/live\.rte\.ie/)).toBeInTheDocument(); // Host mismatch surfaced in the explanation
    expect(screen.getByText(/Align the CDN forwarded Host header/)).toBeInTheDocument();

    // Comparison table lists both endpoints and the from-origin cache evidence.
    const table = screen.getByRole('columnheader', { name: /Cache/ }).closest('table') as HTMLElement;
    expect(within(table).getByText('akamai-edge')).toBeInTheDocument();
    expect(within(table).getByText('fastly-edge')).toBeInTheDocument();
    expect(within(table).getByText(/from origin/)).toBeInTheDocument();

    // NOC lacks dns.explain.read → no Run-now action.
    expect(screen.queryByRole('button', { name: /Run now/ })).toBeNull();
  });

  it('offers the Run-now action to a viewing engineer', async () => {
    stubApi(VE);
    renderAt('/stream-assurance');
    expect(await screen.findByRole('button', { name: /Run now/ })).toBeInTheDocument();
  });
});

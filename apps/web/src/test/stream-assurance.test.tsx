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

    // Latest run + durable alert both surface the incident classification.
    expect((await screen.findAllByText('ORIGIN_VARIANT_MISMATCH')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SA-CDN-001/).length).toBeGreaterThan(0);
    expect(screen.getByText(/live\.rte\.ie/)).toBeInTheDocument(); // Host mismatch surfaced in the run finding
    expect(screen.getByText(/Align the CDN forwarded Host header/)).toBeInTheDocument();

    // Comparison table lists both endpoints and the from-origin cache evidence.
    const table = screen.getByRole('columnheader', { name: /Cache/ }).closest('table') as HTMLElement;
    expect(within(table).getByText('akamai-edge')).toBeInTheDocument();
    expect(within(table).getByText('fastly-edge')).toBeInTheDocument();
    expect(within(table).getByText(/from origin/)).toBeInTheDocument();

    // Durable alerts with lifecycle state are surfaced.
    expect(await screen.findByRole('heading', { name: /Active alerts/ })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument(); // alert state badge

    // CMAF/DRM inspector: parsed init metadata surfaces per endpoint; expanding reveals the CENC
    // scheme + PSSH system (KID/scheme shown, never keys).
    const inspector = screen.getByRole('button', { name: /fastly-edge/ });
    expect(inspector).toBeInTheDocument();
    inspector.click();
    expect(await screen.findByText(/Widevine/)).toBeInTheDocument();
    expect(screen.getByText('tenc')).toBeInTheDocument(); // the tenc box, KID/scheme shown (never keys)

    // NOC lacks dns.explain.read → no diagnostic actions.
    expect(screen.queryByRole('button', { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /acknowledge/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Event mode/ })).toBeNull();
  });

  it('offers diagnostic actions (run, event mode, acknowledge) to a viewing engineer', async () => {
    stubApi(VE);
    renderAt('/stream-assurance');
    expect(await screen.findByRole('button', { name: /Run now/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Event mode/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /acknowledge/ })).toBeInTheDocument();
  });
});

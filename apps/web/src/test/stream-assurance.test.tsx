// Stream Tests page: profile list, CDN comparison table and the origin-variant finding; the
// Run-now action is gated to a viewing engineer; profile creation to an engineer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { ENGINEER, NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Stream Tests page', () => {
  it('shows the CDN comparison and the origin-variant finding to a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/stream-assurance');
    expect(await screen.findByRole('heading', { name: 'Stream Tests', level: 1 })).toBeInTheDocument();

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

    // NOC lacks dns.explain.read / connector.manage → no diagnostic or config actions.
    expect(screen.queryByRole('button', { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /acknowledge/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Event mode/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New profile/ })).toBeNull();
  });

  it('offers diagnostic actions (run, event mode, acknowledge) to a viewing engineer', async () => {
    stubApi(VE);
    renderAt('/stream-assurance');
    expect(await screen.findByRole('button', { name: /Run now/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Event mode/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /acknowledge/ })).toBeInTheDocument();
    // VE cannot configure profiles.
    expect(screen.queryByRole('button', { name: /New profile/ })).toBeNull();
  });

  it('prefills the RTÉ CDN endpoints and lets an engineer create the profile', async () => {
    const fetchMock = stubApi(ENGINEER);
    renderAt('/stream-assurance');
    // Open the create form — it comes prefilled with the three RTÉ CDNs from the steering record.
    fireEvent.click(await screen.findByRole('button', { name: /New profile/ }));
    expect(await screen.findByRole('heading', { name: /New Stream Test profile/ })).toBeInTheDocument();
    expect((screen.getByDisplayValue('liveedge.rte.ie') as HTMLInputElement)).toBeInTheDocument(); // Réalta
    expect((screen.getByDisplayValue('t.sni.global.fastly.net') as HTMLInputElement)).toBeInTheDocument(); // Fastly
    expect((screen.getByDisplayValue('live.rte.ie.akamaized.net') as HTMLInputElement)).toBeInTheDocument(); // Akamai

    fireEvent.click(screen.getByRole('button', { name: /Create profile/ }));

    // The POST fires with the prefilled RTÉ payload — three endpoints, Réalta as the reference.
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/stream-assurance/profiles') && (c[1] as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      const payload = JSON.parse(String((call![1] as RequestInit).body));
      expect(payload.id).toBe('channel4');
      expect(payload.config.endpoints).toHaveLength(3);
      expect(payload.config.endpoints[0]).toMatchObject({ endpointId: 'realta', provider: 'realta', role: 'reference', connectHost: 'liveedge.rte.ie', hostHeader: 'live.rte.ie' });
      expect(payload.config.endpoints.map((e: { connectHost: string }) => e.connectHost)).toEqual(['liveedge.rte.ie', 't.sni.global.fastly.net', 'live.rte.ie.akamaized.net']);
      expect(payload.config.manifests.dashMpdUrl).toContain('channel4.isml/.mpd');
    });
  });
});

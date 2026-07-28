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

    // Comparison table lists both endpoints and the from-origin cache evidence, with the FULL KID.
    const table = screen.getByRole('columnheader', { name: /Cache/ }).closest('table') as HTMLElement;
    expect(within(table).getByText('akamai-edge')).toBeInTheDocument();
    expect(within(table).getByText('fastly-edge')).toBeInTheDocument();
    expect(within(table).getByText(/from origin/)).toBeInTheDocument();
    expect(within(table).getByText('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBeInTheDocument(); // full KID, not truncated

    // Response-headers inspector surfaces the redacted headers each CDN returned.
    fireEvent.click(await screen.findByRole('button', { name: /akamai-edge/ }));
    expect(await screen.findByText('x-cache-remote')).toBeInTheDocument();
    expect(screen.getByText(/TCP_MISS from a2.akamai/)).toBeInTheDocument();

    // Durable alerts with lifecycle state are surfaced.
    expect(await screen.findByRole('heading', { name: /Active alerts/ })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument(); // alert state badge

    // Media checks panel shows the manifest/fragment checks ran (positive display, not only findings).
    expect(await screen.findByRole('heading', { name: /Media checks/ })).toBeInTheDocument();
    expect(screen.getByText(/3 renditions/)).toBeInTheDocument(); // DASH ladder count
    expect(screen.getByText(/seq 100/)).toBeInTheDocument(); // sampled fragment

    // CMAF/DRM inspector: parsed init metadata surfaces per endpoint; expanding reveals the CENC
    // scheme + PSSH system (KID/scheme shown, never keys). Handler 4cc shows a friendly label.
    const inspector = screen.getByRole('button', { name: /fastly-edge.*cenc/ }); // the CMAF-inspector card (vs the headers card)
    expect(inspector).toBeInTheDocument();
    inspector.click();
    expect(await screen.findByText(/Widevine/)).toBeInTheDocument();
    expect(screen.getByText('tenc')).toBeInTheDocument(); // the tenc box, KID/scheme shown (never keys)
    expect(screen.getByText(/video · avc1/)).toBeInTheDocument(); // 'vide' shown as 'video'

    // NOC lacks dns.explain.read / connector.manage → no diagnostic or config actions.
    expect(screen.queryByRole('button', { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /acknowledge/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Event mode/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New profile/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete RTÉ One/ })).toBeNull(); // no delete for NOC
  });

  it('lets an engineer delete a profile', async () => {
    const fetchMock = stubApi(ENGINEER);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/stream-assurance');
    const del = await screen.findByRole('button', { name: /Delete RTÉ One/ });
    fireEvent.click(del);
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => /\/stream-assurance\/profiles\/rte-one$/.test(String(c[0])) && (c[1] as RequestInit)?.method === 'DELETE');
      expect(call).toBeTruthy();
    });
    vi.mocked(window.confirm).mockRestore();
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

    // Pick a channel → RADAR resolves the manifest (feed → SMIL → redirects) and fills the form.
    fireEvent.change(await screen.findByRole('combobox', { name: /Channel/ }), { target: { value: 'RTEONE' } });
    fireEvent.click(screen.getByRole('button', { name: /Load channel/ }));
    await vi.waitFor(() => {
      const urls = screen.getAllByPlaceholderText(/public object URL/) as HTMLInputElement[];
      expect(urls[0].value).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-video=6000000.dash');
    });
    expect((screen.getByPlaceholderText('RTÉ delivery (test)') as HTMLInputElement).value).toBe('RTÉ One'); // name filled from channel

    // Discover from a manifest URL directly also auto-fills the object URLs.
    fireEvent.change(screen.getByPlaceholderText(/DASH .mpd URL/), { target: { value: 'https://dai.google.com/x/manifest.mpd' } });
    fireEvent.click(screen.getByRole('button', { name: /^Discover$/ }));
    expect(await screen.findByText(/Found/)).toHaveTextContent(/2 video renditions/);
    await vi.waitFor(() => {
      const urls = screen.getAllByPlaceholderText(/public object URL/) as HTMLInputElement[];
      expect(urls[0].value).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-video=6000000.dash');
    });

    fireEvent.click(screen.getByRole('button', { name: /Create profile/ }));

    // The POST fires with the discovered object URL across three endpoints, Réalta as the reference.
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/stream-assurance/profiles') && (c[1] as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      const payload = JSON.parse(String((call![1] as RequestInit).body));
      expect(payload.id).toBe('rteone'); // set from the picked channel's callSign
      expect(payload.config.endpoints).toHaveLength(3);
      expect(payload.config.endpoints[0]).toMatchObject({ endpointId: 'realta', provider: 'realta', role: 'reference', connectHost: 'liveedge.rte.ie', hostHeader: 'live.rte.ie' });
      expect(payload.config.endpoints.map((e: { connectHost: string }) => e.connectHost)).toEqual(['liveedge.rte.ie', 't.sni.global.fastly.net', 'live.rte.ie.akamaized.net']);
      // Discover overwrote the object + manifest URLs with the derived ones (top video rendition).
      expect(payload.config.endpoints[0].publicUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-video=6000000.dash');
      expect(payload.config.manifests.dashMpdUrl).toBe('https://dai.google.com/x/manifest.mpd');
    });
  });
});

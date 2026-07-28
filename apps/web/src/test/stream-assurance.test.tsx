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

  it('lets an engineer create a profile from the console form', async () => {
    const fetchMock = stubApi(ENGINEER);
    renderAt('/stream-assurance');
    // Open the create form.
    fireEvent.click(await screen.findByRole('button', { name: /New profile/ }));
    expect(await screen.findByRole('heading', { name: /New Stream Test profile/ })).toBeInTheDocument();

    // Fill the minimum required fields (id, name, and each endpoint's id/publicUrl/connectHost).
    fireEvent.change(screen.getByPlaceholderText('rte-test'), { target: { value: 'my-test' } });
    fireEvent.change(screen.getByPlaceholderText('RTÉ delivery (test)'), { target: { value: 'My Test' } });
    const epIds = screen.getAllByPlaceholderText(/endpoint id/);
    const urls = screen.getAllByPlaceholderText(/public object URL/);
    const hosts = screen.getAllByPlaceholderText(/connect host/);
    fireEvent.change(epIds[0], { target: { value: 'fastly' } });
    fireEvent.change(urls[0], { target: { value: 'https://live.rte.ie/init.mp4' } });
    fireEvent.change(hosts[0], { target: { value: '1.2.3.4' } });
    fireEvent.change(epIds[1], { target: { value: 'akamai' } });
    fireEvent.change(urls[1], { target: { value: 'https://live.rte.ie/init.mp4' } });
    fireEvent.change(hosts[1], { target: { value: '5.6.7.8' } });

    fireEvent.click(screen.getByRole('button', { name: /Create profile/ }));

    // The POST fired with the assembled profile payload.
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/stream-assurance/profiles') && (c[1] as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      const payload = JSON.parse(String((call![1] as RequestInit).body));
      expect(payload.id).toBe('my-test');
      expect(payload.config.endpoints).toHaveLength(2);
      expect(payload.config.endpoints[0]).toMatchObject({ endpointId: 'fastly', role: 'reference', publicUrl: 'https://live.rte.ie/init.mp4', connectHost: '1.2.3.4' });
    });
  });
});

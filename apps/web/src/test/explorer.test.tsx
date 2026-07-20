import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { VE, renderAt, stubApi } from './helpers';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('NS1 Explorer — discovery & selection', () => {
  it('lists the records in a selected zone (URL-addressable)', async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie');
    expect(await screen.findByText('Records in rte.ie')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /live\.rte\.ie/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vod\.rte\.ie/ })).toBeInTheDocument();
  });

  it('renders the record addressed by the URL and tracks it as recent', async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    expect(await screen.findByText(/Record:/)).toBeInTheDocument();
    expect(await screen.findByText('192.0.2.10')).toBeInTheDocument(); // record rendered in the Config view
    // Recent convenience is populated after viewing.
    expect(await screen.findByText('Recent:')).toBeInTheDocument();
  });

  it("shows each record's TTL as a badge in the record list", async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    expect(await screen.findByText('TTL 300s')).toBeInTheDocument(); // live.rte.ie (ttl 300)
    expect(screen.getAllByText('TTL 30s').length).toBeGreaterThan(0); // vod.rte.ie list badge + selected-record header
  });

  it('gates the raw NS1 view on ns1.raw.read', async () => {
    const detailOnly = { ...VE, permissions: VE.permissions.filter((p) => p !== 'ns1.raw.read') };
    stubApi(detailOnly);
    const first = renderAt('/explorer/rte.ie/live.rte.ie/A');
    expect(await screen.findByRole('button', { name: 'Raw NS1' })).toBeDisabled();
    first.unmount();

    vi.unstubAllGlobals();
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    const raw = await screen.findByRole('button', { name: 'Raw NS1' });
    expect(raw).not.toBeDisabled();
    await userEvent.click(raw);
    expect(await screen.findByText(/_radar_note/)).toBeInTheDocument(); // raw object shown
  });

  it('shows an error state when a record cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const p = String(input);
        if (p.endsWith('/api/v1/me')) return new Response(JSON.stringify(VE), { status: 200 });
        if (p.endsWith('/ns1/config')) return new Response(JSON.stringify({ mode: 'mock', synthetic: true, readOnly: true }), { status: 200 });
        if (/\/ns1\/zones\/[^/]+\/[^/]+\/[^/]+$/.test(p)) return new Response(JSON.stringify({ code: 'NS1_NOT_FOUND', message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify({ provenance: {}, zones: [], zone: { records: [] } }), { status: 200 });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/explorer/rte.ie/ghost.rte.ie/A']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/NS1_NOT_FOUND/)).toBeInTheDocument();
  });
});

describe('NS1 Explorer — deep links', () => {
  it('a Steering row record link opens that record in the Explorer', async () => {
    stubApi(VE);
    renderAt('/steering');
    const eir = await screen.findByText('Ireland / Eir / ECS present');
    const row = eir.closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'record' }));
    await waitFor(() => expect(screen.getByText(/Record:/)).toBeInTheDocument());
    expect(await screen.findByText('192.0.2.10')).toBeInTheDocument(); // record rendered in the Config view
  });
});

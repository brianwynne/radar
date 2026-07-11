import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

function customFetch(handler: (path: string) => { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const p = String(input).split('?')[0];
      if (p.endsWith('/api/v1/me')) return new Response(JSON.stringify(VE), { status: 200 });
      if (p.endsWith('/ns1/config')) return new Response(JSON.stringify({ mode: 'mock', synthetic: true, readOnly: true }), { status: 200 });
      const { status, body } = handler(p);
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

describe('Activity screen', () => {
  it('shows a loading state, then rows rendered from the API', async () => {
    stubApi(VE);
    renderAt('/activity');
    expect(screen.getByText(/Loading/i)).toBeInTheDocument(); // a loading state is shown first
    // Rows come from the API response (not a component fixture).
    expect(await screen.findByText('brian@rte.ie')).toBeInTheDocument();
    expect(screen.getByText('radar-read-only')).toBeInTheDocument();
    expect(screen.getByText(/fixture-derived/i)).toBeInTheDocument();
  });

  it('shows the mock/synthetic disclosure', async () => {
    stubApi(VE);
    renderAt('/activity');
    expect(await screen.findByText(/MOCK MODE — data is SYNTHETIC/i)).toBeInTheDocument();
  });

  it('filters rows by action', async () => {
    stubApi(VE);
    renderAt('/activity');
    await screen.findByText('brian@rte.ie');
    await userEvent.type(screen.getByPlaceholderText('update / view'), 'view');
    expect(screen.queryByText('brian@rte.ie')).toBeNull(); // the "update" row is filtered out
    expect(screen.getByText('radar-read-only')).toBeInTheDocument(); // the "view" row remains
  });

  it('denies a NOC viewer (no audit.read)', async () => {
    stubApi(NOC);
    renderAt('/activity');
    expect(await screen.findByText(/do not have permission to view the activity log/i)).toBeInTheDocument();
  });

  it('shows an empty state when there is no activity', async () => {
    customFetch((p) => (p.endsWith('/ns1/activity') ? { status: 200, body: { provenance: {}, mappingNote: '', count: 0, items: [] } } : { status: 200, body: {} }));
    render(
      <MemoryRouter initialEntries={['/activity']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No activity recorded/i)).toBeInTheDocument();
  });

  it('shows an error state on upstream failure', async () => {
    customFetch((p) => (p.endsWith('/ns1/activity') ? { status: 502, body: { code: 'NS1_UPSTREAM_UNAVAILABLE', message: 'nope' } } : { status: 200, body: {} }));
    render(
      <MemoryRouter initialEntries={['/activity']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/NS1_UPSTREAM_UNAVAILABLE/)).toBeInTheDocument();
  });
});

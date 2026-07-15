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
const renderAppAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('Activity — RADAR audit tab (default)', () => {
  it('shows RADAR audit events from /api/v1/audit, not hard-coded', async () => {
    stubApi(VE);
    renderAt('/activity');
    expect(await screen.findByRole('button', { name: 'RADAR Activity' })).toHaveClass('active');
    expect(await screen.findByText('rte.ie/live.rte.ie/A')).toBeInTheDocument(); // resource from the API
    expect(screen.getByText('dev')).toBeInTheDocument(); // authentication method
    expect(screen.getByText('corr-1')).toBeInTheDocument(); // correlation id
    // These are RADAR actions, not NS1 activity.
    expect(screen.getByText('snapshot.create')).toBeInTheDocument();
    expect(screen.queryByText('brian@rte.ie')).toBeNull();
  });

  it('filters RADAR audit by action', async () => {
    stubApi(VE);
    renderAt('/activity');
    await screen.findByText('snapshot.create');
    await userEvent.type(screen.getByPlaceholderText('snapshot.create'), 'auth.login');
    expect(screen.queryByText('snapshot.create')).toBeNull();
    expect(screen.getByText('auth.login')).toBeInTheDocument();
  });

  it('empty and error states', async () => {
    customFetch((p) => (p.endsWith('/api/v1/audit') ? { status: 200, body: { provenance: {}, count: 0, items: [] } } : { status: 200, body: {} }));
    renderAppAt('/activity');
    expect(await screen.findByText(/No RADAR audit events recorded/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
    customFetch((p) => (p.endsWith('/api/v1/audit') ? { status: 502, body: { code: 'NS1_UPSTREAM_UNAVAILABLE', message: 'x' } } : { status: 200, body: {} }));
    renderAppAt('/activity');
    expect(await screen.findByText(/NS1_UPSTREAM_UNAVAILABLE/)).toBeInTheDocument();
  });
});

describe('Activity — NS1 tab is separate and mock-labelled', () => {
  it('switches to NS1 activity, keeping the mock/synthetic disclosure', async () => {
    stubApi(VE);
    renderAt('/activity');
    await screen.findByText('snapshot.create'); // RADAR tab first
    await userEvent.click(screen.getByRole('button', { name: 'NS1 Activity' }));
    expect(await screen.findByText('brian@rte.ie')).toBeInTheDocument(); // NS1 activity actor
    expect(screen.getByText(/fixture-derived/i)).toBeInTheDocument(); // NS1 mapping note (per-view disclosure)
  });
});

describe('Activity — permission', () => {
  it('denies a NOC viewer', async () => {
    stubApi(NOC);
    renderAt('/activity');
    expect(await screen.findByText(/do not have permission to view activity/i)).toBeInTheDocument();
  });
});

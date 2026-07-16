// Commercial CDN page: Fastly and Akamai side by side. The Fastly column shows its per-service
// filter, the selected service's realtime response-code panel (with per-class drill-down into
// individual codes), and a compact service table; the Akamai column states its pending status.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { NOC, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Commercial CDN page', () => {
  it('shows Fastly and Akamai columns side by side', async () => {
    stubApi(NOC);
    renderAt('/cdn');

    expect(await screen.findByRole('heading', { name: /Commercial CDN/, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fastly', level: 2 })).toBeInTheDocument();
    const akamai = screen.getByRole('heading', { name: 'Akamai', level: 2 }).closest('.cdn-col') as HTMLElement;
    // Akamai is honest about its pending connector (Reporting API grant), never fabricated data.
    expect(within(akamai).getByText(/Reporting API/)).toBeInTheDocument();
    expect(within(akamai).getByText('NOT CONNECTED')).toBeInTheDocument();
  });

  it('the service filter drives a realtime response-code panel; a class drills into codes', async () => {
    stubApi(NOC);
    renderAt('/cdn');

    const fastly = (await screen.findByRole('heading', { name: 'Fastly', level: 2 })).closest('.cdn-col') as HTMLElement;

    // Wait for data to load — the response-code panel appears once a service is selected.
    const panel = (await within(fastly).findByText(/Response codes/)).closest('.status-panel') as HTMLElement;

    // The service filter defaults to the busiest service (RTÉ Player VOD, which is streaming).
    const select = within(fastly).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('SU-vod');

    // Response-code panel: 2xx/3xx/4xx/5xx classes with the latest per-second values.
    for (const cls of ['2xx', '3xx', '4xx', '5xx']) expect(within(panel).getByText(cls)).toBeInTheDocument();
    expect(within(panel).getByText('573')).toBeInTheDocument(); // latest 2xx for SU-vod

    // Click the 2xx class → drill down to the individual codes (200, 206) within it.
    fireEvent.click(within(panel).getByRole('button', { name: /2xx/ }));
    expect(await within(panel).findByText('200')).toBeInTheDocument();
    expect(within(panel).getByText('206')).toBeInTheDocument();
    expect(within(panel).getByText('540')).toBeInTheDocument(); // latest 200 count

    // Both services are present (in the filter and the compact table); no token leaks anywhere.
    expect(within(fastly).getAllByText('RTÉ Live').length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toMatch(/fastly-key/i);
  });
});

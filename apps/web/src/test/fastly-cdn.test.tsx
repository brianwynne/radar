// Fastly CDN page: renders the delivery summary and the per-service telemetry table (hit ratio,
// bandwidth, origin offload, error rate) from the mock API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { NOC, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Fastly CDN page', () => {
  it('shows the summary and a per-service row with its hit ratio', async () => {
    stubApi(NOC);
    renderAt('/cdn/fastly');

    // Wait for the page + data (AuthProvider resolves asynchronously) before synchronous asserts.
    // 'RTÉ Player VOD' also appears in the live-tail (idle card); pick the one in the services table.
    const vodCells = await screen.findAllByText('RTÉ Player VOD');
    const vodRow = within(vodCells.map((e) => e.closest('tr')).find(Boolean)! as HTMLElement);
    expect(screen.getByRole('heading', { name: /Fastly CDN/, level: 1 })).toBeInTheDocument();
    expect(vodRow.getByText('92.0%')).toBeInTheDocument(); // hit ratio
    expect(vodRow.getByText('0.2%')).toBeInTheDocument(); // error rate

    // The second service is present too (it now also appears in the live-tail, so allow duplicates).
    expect(screen.getAllByText('RTÉ Live').length).toBeGreaterThan(0);

    // Summary reflects the connector snapshot (the "Services" tile — disambiguated from the h2).
    const tile = screen.getAllByText('Services').map((el) => el.closest('.card')).find(Boolean)! as HTMLElement;
    expect(within(tile).getByText('2')).toBeInTheDocument();
  });

  it('renders the real-time live-tail: a per-second card with sparklines, and an idle service', async () => {
    stubApi(NOC);
    renderAt('/cdn/fastly');

    // Anchor on the buffered-count line (unique to the live-tail) to find the streaming card.
    const liveCard = (await screen.findByText(/3\/120 buffered/)).closest('.card') as HTMLElement;
    expect(within(liveCard).getByText('RTÉ Live')).toBeInTheDocument();
    expect(within(liveCard).getByText('588/s')).toBeInTheDocument(); // latest req/s
    expect(within(liveCard).getByLabelText(/requests per second/i)).toBeInTheDocument(); // sparkline svg
    expect(within(liveCard).getByLabelText(/bandwidth/i)).toBeInTheDocument();

    // The idle VOD service is honest: shown as idle, not fabricated zeros. (Its card is the one
    // inside the live-tail grid — find the "idle" note and assert it names no traffic.)
    expect(screen.getByText(/idle — no traffic in the last 120s/)).toBeInTheDocument();
    expect(screen.getByText(/per-second · 120s window/)).toBeInTheDocument();
  });
});

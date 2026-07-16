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
    const vodRow = within((await screen.findByText('RTÉ Player VOD')).closest('tr')!);
    expect(screen.getByRole('heading', { name: /Fastly CDN/, level: 1 })).toBeInTheDocument();
    expect(vodRow.getByText('92.0%')).toBeInTheDocument(); // hit ratio
    expect(vodRow.getByText('0.2%')).toBeInTheDocument(); // error rate

    // The second service is present too.
    expect(screen.getByText('RTÉ Live')).toBeInTheDocument();

    // Summary reflects the connector snapshot (the "Services" tile — disambiguated from the h2).
    const tile = screen.getAllByText('Services').map((el) => el.closest('.card')).find(Boolean)! as HTMLElement;
    expect(within(tile).getByText('2')).toBeInTheDocument();
  });
});

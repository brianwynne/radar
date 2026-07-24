// BGP Intelligence (RIPE) page: overview, worst-first prefix table with RPKI + RIS visibility, the
// evidence drawer (paths, CloudVision "not yet available", links), and the RIS Live event timeline.
import { describe, expect, it } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { NOC, renderAt, stubApi } from './helpers';

describe('BGP Intelligence page', () => {
  it('shows the overview, worst-first table, RPKI + source state, and events', async () => {
    stubApi(NOC);
    renderAt('/bgp-intelligence');
    expect(await screen.findByRole('heading', { name: /BGP Intelligence/, level: 1 })).toBeInTheDocument();

    // Wait for data to load, then assert the RPKI-invalid /24 (critical) sorts above the healthy /21.
    const invalidCell = await screen.findByText('89.207.57.0/24');
    const table = invalidCell.closest('table')! as HTMLElement;
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('89.207.57.0/24')).toBeInTheDocument();
    expect(within(rows[0]).getByText('RPKI invalid')).toBeInTheDocument();
    expect(within(table).getByText('89.207.56.0/21')).toBeInTheDocument();

    // Source status live + a RIS event (the announcement badge in the timeline).
    expect(screen.getByText(/RIPE source: live/)).toBeInTheDocument();
    expect(screen.getAllByText('announcement').length).toBeGreaterThan(0);
  });

  it('opens the evidence drawer with paths and the CloudVision-not-yet-available note', async () => {
    stubApi(NOC);
    renderAt('/bgp-intelligence');
    // Scope to the prefix table (the same prefix also appears in the events timeline).
    const table = (await screen.findByText('89.207.57.0/24')).closest('table')! as HTMLElement;
    const row = within(table).getByText('89.207.56.0/21');
    fireEvent.click(row);
    // Observed collector path (grouped) + upstream.
    expect(await screen.findByText(/observed path, not the physical network/i)).toBeInTheDocument();
    // CloudVision correlation is explicitly not-yet-available (never inferred from RIPE).
    expect(screen.getAllByText(/not yet available/i).length).toBeGreaterThan(0);
    // ASN owner names are resolved and shown side-by-side (174 → Cogent in the stub) — in the
    // upstreams list and again in the observed path.
    expect((await screen.findAllByText(/Cogent/)).length).toBeGreaterThan(0);
    // External links.
    expect(screen.getByText(/RIPEstat ↗/)).toHaveAttribute('href', expect.stringContaining('stat.ripe.net'));
  });
});

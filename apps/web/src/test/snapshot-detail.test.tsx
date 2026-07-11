import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const ID = '11111111-1111-1111-1111-111111111111';
const at = `/snapshots/${ID}`;

describe('Snapshot detail', () => {
  it('shows metadata, provenance and the synthetic tag to a Viewing Engineer', async () => {
    stubApi(VE);
    renderAt(at);
    expect(await screen.findByText(/Metadata & provenance/i)).toBeInTheDocument();
    expect(screen.getAllByText('rte.ie/live.rte.ie/A').length).toBeGreaterThan(0);
    expect(screen.getByText('dev-engineer')).toBeInTheDocument();
    expect(screen.getAllByText(/MOCK · SYNTHETIC/).length).toBeGreaterThan(0);
  });

  it('denies a NOC viewer', async () => {
    stubApi(NOC);
    renderAt(at);
    expect(await screen.findByText(/do not have permission to view snapshots/i)).toBeInTheDocument();
  });

  it('renders the canonical payload tab', async () => {
    stubApi(VE);
    renderAt(at);
    await screen.findByText(/Metadata & provenance/i);
    await userEvent.click(screen.getByRole('button', { name: 'Canonical payload' }));
    expect(await screen.findByText(/"domain": "live.rte.ie"/)).toBeInTheDocument();
  });

  it('gates the raw payload tab on ns1.raw.read', async () => {
    const readOnly = { ...VE, permissions: VE.permissions.filter((p) => p !== 'ns1.raw.read') };
    stubApi(readOnly);
    renderAt(at);
    expect(await screen.findByRole('button', { name: 'Raw payload' })).toBeDisabled();
  });

  it('compares with the current record: shows the read-only notice, the diff, and NO restore/apply control', async () => {
    stubApi(VE);
    renderAt(at);
    await screen.findByText(/Metadata & provenance/i);
    // The read-only comparison notice is present up front.
    expect(screen.getByText(/Comparison only — no NS1 change has been made/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Compare with current/i }));
    expect(await screen.findByText('Snapshot vs current record')).toBeInTheDocument();
    expect(screen.getByText('Stored snapshot')).toBeInTheDocument();
    expect(screen.getByText('Current record')).toBeInTheDocument();
    expect(screen.getByText('Change summary')).toBeInTheDocument();
    expect(screen.getByText('answers[0].meta.weight')).toBeInTheDocument(); // a field change from the API
    expect(screen.getByText(/read in mock mode/i)).toBeInTheDocument(); // warning surfaced

    // Read-only guarantee: no restore/apply/rollback control anywhere.
    expect(screen.queryByRole('button', { name: /restore|apply|rollback/i })).toBeNull();
  });
});

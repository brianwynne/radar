import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOC, ENGINEER, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const openResolvers = async () => {
  renderAt('/network');
  await userEvent.click(await screen.findByRole('button', { name: 'Resolvers' }));
  await screen.findByText('Eir');
};

describe('Resolver reader tab', () => {
  it('shows the per-ISP baseline: platform, pool split, TTL honouring, and the no-coverage gap', async () => {
    stubApi(NOC);
    await openResolvers();
    expect(screen.getByText(/Réalta 100%/)).toBeInTheDocument();
    // Apex (live.rte.ie) + edge carry a TTL honoured badge; the record shows the steering-window badge
    // (not a redundant "honoured"), so exactly two honoured badges appear in the chain.
    expect(screen.getAllByText('TTL honoured').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/steering held/i)).toBeInTheDocument(); // record's steering-window badge
    expect(screen.getByText(/185\.54\.104/)).toBeInTheDocument(); // CW/PW pool split visible
    expect(screen.getByText(/No RIPE Atlas probe coverage/i)).toBeInTheDocument(); // Three gap
  });

  it('badges every resolver TTL honoured / not honoured (inflaters flagged)', async () => {
    stubApi(NOC);
    await openResolvers();
    await userEvent.click((await screen.findAllByRole('button', { name: /resolver answers/i }))[0]);
    // On-net + public resolvers respect the published record TTL → honoured.
    expect((await screen.findAllByText('TTL honoured')).length).toBeGreaterThan(0);
    // The probe-local Docker resolver (127.0.0.11) serves 377s > published → not honoured.
    expect(screen.getByText('TTL not honoured')).toBeInTheDocument();
  });

  it('hides the engineer controls from a viewer', async () => {
    stubApi(NOC);
    await openResolvers();
    expect(screen.queryByRole('button', { name: /^Check /i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/6h polling/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Domain to check/i)).not.toBeInTheDocument();
  });

  it('gives an engineer the check button, domain input and a working polling switch', async () => {
    stubApi(ENGINEER);
    await openResolvers();
    expect(screen.getByRole('button', { name: /^Check /i })).toBeInTheDocument();
    // Domain box defaults (placeholder) to the configured record and lets a different one be checked.
    expect((screen.getByLabelText(/Domain to check/i) as HTMLInputElement).placeholder).toBe('live.rte.ie');
    const poll = screen.getByLabelText(/6h polling/i) as HTMLInputElement;
    expect(poll.checked).toBe(true);
    await userEvent.click(poll); // → POST /polling {enabled:false} → stub returns pollingEnabled:false
    await waitFor(() => expect((screen.getByLabelText(/6h polling/i) as HTMLInputElement).checked).toBe(false));
  });
});

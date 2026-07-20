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
    expect(screen.getByText('honoured')).toBeInTheDocument(); // edge TTL ≤ threshold
    expect(screen.getByText(/185\.54\.104/)).toBeInTheDocument(); // CW/PW pool split visible
    expect(screen.getByText(/No RIPE Atlas probe coverage/i)).toBeInTheDocument(); // Three gap
  });

  it('hides the engineer controls from a viewer', async () => {
    stubApi(NOC);
    await openResolvers();
    expect(screen.queryByRole('button', { name: /Check resolvers now/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/6h polling/i)).not.toBeInTheDocument();
  });

  it('gives an engineer the check button and a working polling switch', async () => {
    stubApi(ENGINEER);
    await openResolvers();
    expect(screen.getByRole('button', { name: /Check resolvers now/i })).toBeInTheDocument();
    const poll = screen.getByLabelText(/6h polling/i) as HTMLInputElement;
    expect(poll.checked).toBe(true);
    await userEvent.click(poll); // → POST /polling {enabled:false} → stub returns pollingEnabled:false
    await waitFor(() => expect((screen.getByLabelText(/6h polling/i) as HTMLInputElement).checked).toBe(false));
  });
});

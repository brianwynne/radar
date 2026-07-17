import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const rowByScenario = (label: string) => screen.getByText(label).closest('tr') as HTMLElement;

describe('Steering Matrix', () => {
  it('NOC Viewer can access the steering summary (evaluation gated to Viewing Engineer)', async () => {
    stubApi(NOC);
    renderAt('/steering');
    expect(await screen.findByText('Steering Matrix')).toBeInTheDocument();
    expect(screen.getByText(/Full per-scenario evaluation requires the Viewing Engineer role/i)).toBeInTheDocument();
    expect(screen.getAllByText('Requires Viewing Engineer').length).toBeGreaterThan(0);
  });

  it('generates rows from API evaluation responses (not hard-coded)', async () => {
    stubApi(VE);
    renderAt('/steering');
    const eir = await screen.findByText('Ireland / Eir / ECS present');
    const row = eir.closest('tr') as HTMLElement;
    expect(within(row).getByText('ecs')).toBeInTheDocument(); // identity source from the API
    expect(within(row).getByText('Réalta, Fastly')).toBeInTheDocument(); // eligible platforms from the API
    expect(within(row).getByText('probabilistic')).toBeInTheDocument(); // distribution labelled probabilistic
    expect(within(row).getByText(/Réalta 78%/)).toBeInTheDocument();
  });

  it('marks the unsupported-filter scenario Partial with no definitive platform', async () => {
    stubApi(VE);
    renderAt('/steering');
    await screen.findByText('Ireland / Eir / ECS present');
    const row = rowByScenario('Unsupported filter (shed_load)');
    expect(within(row).getByText('Partial')).toBeInTheDocument();
    // No definitive distribution / winner for a partial evaluation (a probabilistic
    // distribution is never shown). The configured PNI target may still contain a %.
    expect(within(row).queryByText('probabilistic')).toBeNull();
    expect(within(row).queryByText(/78%/)).toBeNull();
  });

  it('opens the full Explain view when a row is selected (full flow)', async () => {
    stubApi(VE);
    renderAt('/steering');
    const eir = await screen.findByText('Ireland / Eir / ECS present');
    await userEvent.click(eir.closest('tr') as HTMLElement);

    // Now on the Explain view, auto-run with the Eir scenario.
    expect(await screen.findByText(/most likely delivery platform/i)).toBeInTheDocument();
    expect(screen.getAllByText(/AS5466/).length).toBeGreaterThan(0); // Eir / AS5466
    expect(screen.getByText('weighted_shuffle')).toBeInTheDocument(); // Filter Chain
    expect(screen.getByText('78%')).toBeInTheDocument(); // expected distribution bar
    expect(screen.getAllByText('Eir PNI').length).toBeGreaterThan(0); // network path (also echoed in the ISP hint)
    expect(screen.getAllByText(/Cloudflare/).length).toBeGreaterThan(0); // downstream component
  });
});

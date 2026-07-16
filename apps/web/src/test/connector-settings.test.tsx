// Integrations Token Management (Engineer): each connector's token field is write-only (never
// populated from the server); typing a token sends it on save, leaving it blank retains the
// stored one, and "Clear token" sends clearToken. The page hosts a CloudVision section and a
// Cloudflare section.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import { ENGINEER, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

// All connector sections load independently; wait for every token field (order = CloudVision,
// Cloudflare, Fastly) before scoping queries to a section's card so identical controls don't collide.
const cards = async () => {
  await waitFor(() => expect(screen.getAllByPlaceholderText(/leave blank to keep/i)).toHaveLength(3));
  const tokens = screen.getAllByPlaceholderText(/leave blank to keep/i) as HTMLInputElement[];
  return {
    cloudVision: tokens[0].closest('.card') as HTMLElement,
    cloudflare: tokens[1].closest('.card') as HTMLElement,
    fastly: tokens[2].closest('.card') as HTMLElement,
  };
};

const putBody = (suffix: string) => {
  const calls = (fetch as unknown as Mock).mock.calls;
  const put = calls.find((c) => String(c[0]).endsWith(suffix) && (c[1] as RequestInit | undefined)?.method === 'PUT');
  return put ? (JSON.parse(String((put[1] as RequestInit).body)) as Record<string, unknown>) : null;
};

describe('Integrations Token Management', () => {
  it('renders the page and both connector sections', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    await screen.findByRole('heading', { name: 'Integrations Token Management' });
    await screen.findByRole('heading', { name: /CloudVision \(network telemetry\)/i });
    await screen.findByRole('heading', { name: /Cloudflare \(Réalta cache load balancing\)/i });
    await screen.findByRole('heading', { name: /Fastly \(commercial CDN\)/i });
  });

  it('renders a write-only token field per section (blank even when configured)', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const tokens = (await screen.findAllByPlaceholderText(/leave blank to keep/i)) as HTMLInputElement[];
    expect(tokens).toHaveLength(3);
    for (const t of tokens) expect(t.value).toBe(''); // never populated from the server
  });

  it('sends a typed token on save (CloudVision)', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const card = within((await cards()).cloudVision);
    const token = card.getByPlaceholderText(/leave blank to keep/i);
    fireEvent.change(token, { target: { value: 'brand-new-token' } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/i);
    expect(putBody('/network/connection')).toMatchObject({ token: 'brand-new-token' });
  });

  it('omits the token when left blank (retain)', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const card = within((await cards()).cloudVision);
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/i);
    const body = putBody('/network/connection')!;
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('clearToken');
  });

  it('tests the CloudVision connection', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const card = within((await cards()).cloudVision);
    fireEvent.click(card.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connection OK.*devices/i)).toBeInTheDocument();
  });

  it('saves and tests the Cloudflare connection', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const card = within((await cards()).cloudflare);
    const token = card.getByPlaceholderText(/leave blank to keep/i);
    fireEvent.change(token, { target: { value: 'cf-token-xyz' } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/i);
    expect(putBody('/network/cloudflare/connection')).toMatchObject({ token: 'cf-token-xyz' });

    fireEvent.click(card.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connection OK.*load balancers/i)).toBeInTheDocument();
  });

  it('saves and tests the Fastly connection', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const card = within((await cards()).fastly);
    const token = card.getByPlaceholderText(/leave blank to keep/i);
    fireEvent.change(token, { target: { value: 'fastly-token-xyz' } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/i);
    expect(putBody('/cdn/fastly/connection')).toMatchObject({ token: 'fastly-token-xyz' });

    fireEvent.click(card.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connection OK.*services/i)).toBeInTheDocument();
  });
});

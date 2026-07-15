// CloudVision Connection settings (Engineer): the token field is write-only (never populated
// from the server); typing a token sends it on save, leaving it blank retains the stored one,
// and "Clear token" sends clearToken.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { ENGINEER, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const putBody = () => {
  const calls = (fetch as unknown as Mock).mock.calls;
  const put = calls.find((c) => String(c[0]).endsWith('/network/connection') && (c[1] as RequestInit | undefined)?.method === 'PUT');
  return put ? (JSON.parse(String((put[1] as RequestInit).body)) as Record<string, unknown>) : null;
};

describe('CloudVision Connection settings', () => {
  it('renders a write-only token field (blank even when configured)', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    await screen.findByRole('heading', { name: 'CloudVision Connection' });
    const token = (await screen.findByPlaceholderText(/leave blank to keep/i)) as HTMLInputElement;
    expect(token.value).toBe(''); // never populated from the server
    expect(screen.getByText('configured')).toBeInTheDocument();
  });

  it('sends a typed token on save', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    const token = (await screen.findByPlaceholderText(/leave blank to keep/i)) as HTMLInputElement;
    fireEvent.change(token, { target: { value: 'brand-new-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/i);
    expect(putBody()).toMatchObject({ token: 'brand-new-token' });
  });

  it('omits the token when left blank (retain)', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/i);
    const body = putBody()!;
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('clearToken');
  });

  it('tests the connection', async () => {
    stubApi(ENGINEER);
    renderAt('/network/connection');
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connection OK/i)).toBeInTheDocument();
  });
});

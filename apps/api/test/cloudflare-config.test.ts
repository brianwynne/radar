// Cloudflare connector config: mode selection and live-mode requirements.
import { describe, it, expect } from 'vitest';
import { loadCloudflareConfig } from '../src/cloudflare/config.js';

describe('loadCloudflareConfig', () => {
  it('defaults to disabled/mock with no credentials required', () => {
    const c = loadCloudflareConfig({});
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('mock');
    expect(c.token).toBeUndefined();
  });

  it('parses lbZones CSV and poll interval', () => {
    const c = loadCloudflareConfig({ CLOUDFLARE_LB_ZONES: 'rte.ie, rasset.ie ,rte.host', CLOUDFLARE_POLL_INTERVAL_SECONDS: '90' });
    expect(c.lbZones).toEqual(['rte.ie', 'rasset.ie', 'rte.host']);
    expect(c.pollIntervalSeconds).toBe(90);
  });

  it('live mode requires an account id and a token (token from env)', () => {
    expect(() => loadCloudflareConfig({ CLOUDFLARE_ENABLED: 'true', CLOUDFLARE_MODE: 'live', CLOUDFLARE_API_TOKEN: 't' })).toThrow(/account/i);
    expect(() => loadCloudflareConfig({ CLOUDFLARE_ENABLED: 'true', CLOUDFLARE_MODE: 'live', CLOUDFLARE_ACCOUNT_ID: 'a' })).toThrow(/token/i);
    const c = loadCloudflareConfig({ CLOUDFLARE_ENABLED: 'true', CLOUDFLARE_MODE: 'live', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' });
    expect(c).toMatchObject({ enabled: true, mode: 'live', accountId: 'a', token: 't' });
  });
});

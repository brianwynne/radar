// Fastly connector config: mode selection and live-mode requirements.
import { describe, it, expect } from 'vitest';
import { loadFastlyConfig } from '../src/fastly/config.js';

describe('loadFastlyConfig', () => {
  it('defaults to disabled/mock with no credentials required', () => {
    const c = loadFastlyConfig({});
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('mock');
    expect(c.token).toBeUndefined();
    expect(c.windowMinutes).toBe(10);
  });

  it('parses service ids CSV, window and poll interval', () => {
    const c = loadFastlyConfig({ FASTLY_SERVICE_IDS: 'svc-a, svc-b ,svc-c', FASTLY_WINDOW_MINUTES: '5', FASTLY_POLL_INTERVAL_SECONDS: '90' });
    expect(c.serviceIds).toEqual(['svc-a', 'svc-b', 'svc-c']);
    expect(c.windowMinutes).toBe(5);
    expect(c.pollIntervalSeconds).toBe(90);
  });

  it('live mode requires a token (from env)', () => {
    expect(() => loadFastlyConfig({ FASTLY_ENABLED: 'true', FASTLY_MODE: 'live' })).toThrow(/token/i);
    const c = loadFastlyConfig({ FASTLY_ENABLED: 'true', FASTLY_MODE: 'live', FASTLY_API_TOKEN: 't' });
    expect(c).toMatchObject({ enabled: true, mode: 'live', token: 't' });
  });
});

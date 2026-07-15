// CloudVision configuration: mock needs no credentials, live fails clearly without endpoint
// or token, threshold + edge-device parsing, and boolean coercion. Tokens are never returned
// unless in memory for live use.
import { describe, it, expect } from 'vitest';
import { loadCloudVisionConfig } from '../src/cloudvision/config.js';

const base = { NODE_ENV: 'test' as const };

describe('loadCloudVisionConfig', () => {
  it('disabled by default, no credentials required', () => {
    const c = loadCloudVisionConfig({ ...base });
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('mock');
    expect(c.token).toBeUndefined();
  });

  it('mock mode requires no credentials', () => {
    const c = loadCloudVisionConfig({ ...base, CLOUDVISION_ENABLED: 'true', CLOUDVISION_MODE: 'mock' });
    expect(c.enabled).toBe(true);
    expect(c.mode).toBe('mock');
    expect(c.token).toBeUndefined();
  });

  it('live mode fails clearly without an endpoint', () => {
    expect(() => loadCloudVisionConfig({ ...base, CLOUDVISION_ENABLED: 'true', CLOUDVISION_MODE: 'live' })).toThrow(/requires CLOUDVISION_ENDPOINT/);
  });

  it('live mode fails clearly without a token', () => {
    expect(() => loadCloudVisionConfig({ ...base, CLOUDVISION_ENABLED: 'true', CLOUDVISION_MODE: 'live', CLOUDVISION_ENDPOINT: 'https://cvp.example' })).toThrow(/service-account token/);
  });

  it('live mode with endpoint + token loads (token held in memory only)', () => {
    const c = loadCloudVisionConfig({ ...base, CLOUDVISION_ENABLED: 'true', CLOUDVISION_MODE: 'live', CLOUDVISION_ENDPOINT: 'https://cvp.example/', CLOUDVISION_TOKEN: 'secret-token' });
    expect(c.endpoint).toBe('https://cvp.example');
    expect(c.token).toBe('secret-token');
  });

  it('rejects an endpoint that is not HTTPS outside development', () => {
    expect(() => loadCloudVisionConfig({ ...base, NODE_ENV: 'production', CLOUDVISION_ENABLED: 'true', CLOUDVISION_MODE: 'live', CLOUDVISION_ENDPOINT: 'http://cvp.example', CLOUDVISION_TOKEN: 't' })).toThrow(/HTTPS/);
  });

  it('rejects critical < warning', () => {
    expect(() => loadCloudVisionConfig({ ...base, CLOUDVISION_WARNING_PERCENT: '90', CLOUDVISION_CRITICAL_PERCENT: '80' })).toThrow(/must be ≥/);
  });

  it('parses edge device ids and coerces verifyTls', () => {
    const c = loadCloudVisionConfig({ ...base, CLOUDVISION_EDGE_DEVICE_IDS: 'A1, B2 ,C3', CLOUDVISION_VERIFY_TLS: 'false' });
    expect(c.edgeDeviceIds).toEqual(['A1', 'B2', 'C3']);
    expect(c.verifyTls).toBe(false);
  });

  it('applies documented defaults', () => {
    const c = loadCloudVisionConfig({ ...base });
    expect(c).toMatchObject({ timeoutSeconds: 10, pollIntervalSeconds: 10, verifyTls: true, maxSampleAgeSeconds: 30, retryAttempts: 3, primaryDirection: 'outbound' });
  });
});

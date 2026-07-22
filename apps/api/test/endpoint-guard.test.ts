import { describe, expect, it } from 'vitest';
import { assertPublicHttpEndpoint, isInternalHost, UnsafeEndpointError } from '../src/security/endpoint.js';

describe('isInternalHost', () => {
  it('flags loopback / internal / link-local / ULA hosts', () => {
    for (const h of ['localhost', 'foo.localhost', 'svc.internal', 'box.local', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.4', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', 'fd12::9']) {
      expect(isInternalHost(h), h).toBe(true);
    }
  });
  it('allows public hosts', () => {
    for (const h of ['api.fastly.com', 'www.arista.io', '8.8.8.8', 'atlas.ripe.net', '172.15.0.1', '100.63.0.1']) {
      expect(isInternalHost(h), h).toBe(false);
    }
  });
});

describe('assertPublicHttpEndpoint', () => {
  it('accepts a public https URL', () => {
    expect(assertPublicHttpEndpoint('https://api.fastly.com').hostname).toBe('api.fastly.com');
  });
  it('rejects a non-http(s) scheme', () => {
    expect(() => assertPublicHttpEndpoint('ftp://api.fastly.com')).toThrow(UnsafeEndpointError);
  });
  it('rejects cleartext http when https is required', () => {
    expect(() => assertPublicHttpEndpoint('http://api.fastly.com', { requireHttps: true })).toThrow(/HTTPS/);
  });
  it('rejects the cloud metadata address and internal hosts', () => {
    expect(() => assertPublicHttpEndpoint('http://169.254.169.254/latest/meta-data/')).toThrow(/internal|loopback|link-local/i);
    expect(() => assertPublicHttpEndpoint('https://10.0.0.5')).toThrow(UnsafeEndpointError);
  });
  it('rejects embedded credentials (userinfo host-shift trick)', () => {
    expect(() => assertPublicHttpEndpoint('https://api.fastly.com@evil.example')).toThrow(/credentials/i);
  });
  it('rejects a non-URL', () => {
    expect(() => assertPublicHttpEndpoint('not a url')).toThrow(UnsafeEndpointError);
  });
});

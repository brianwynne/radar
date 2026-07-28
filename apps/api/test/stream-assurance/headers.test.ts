import { describe, it, expect } from 'vitest';
import { redactResponseHeaders, providerRequestHeaders } from '../../src/stream-assurance/headers.js';

describe('redactResponseHeaders', () => {
  it('keeps diagnostic headers but redacts credentials/cookies/signed material (name kept)', () => {
    const out = redactResponseHeaders({
      'x-cache': 'TCP_MISS from edge', 'x-cache-remote': 'TCP_HIT from parent', 'age': '12',
      'set-cookie': 'sess=abc123; HttpOnly', 'authorization': 'Bearer xyz',
      'x-amz-signature': 'deadbeef', 'x-api-key': 'k-123', 'cache-control': 'max-age=6',
    });
    expect(out['x-cache']).toBe('TCP_MISS from edge');
    expect(out['x-cache-remote']).toBe('TCP_HIT from parent');
    expect(out['age']).toBe('12');
    expect(out['cache-control']).toBe('max-age=6');
    // Sensitive values replaced, header names retained so the operator knows they were present.
    expect(out['set-cookie']).toBe('[redacted]');
    expect(out['authorization']).toBe('[redacted]');
    expect(out['x-amz-signature']).toBe('[redacted]');
    expect(out['x-api-key']).toBe('[redacted]');
  });
});

describe('providerRequestHeaders', () => {
  it('sends the Akamai cache-debug Pragma so X-Cache is emitted', () => {
    expect(providerRequestHeaders('akamai')).toEqual({ Pragma: 'akamai-x-cache-on, akamai-x-cache-remote-on' });
  });
  it('adds nothing for Fastly (emits X-Cache by default) or other providers', () => {
    expect(providerRequestHeaders('fastly')).toEqual({});
    expect(providerRequestHeaders('realta')).toEqual({});
  });
});

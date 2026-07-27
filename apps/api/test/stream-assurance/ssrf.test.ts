import { describe, it, expect } from 'vitest';
import { validateTarget } from '../../src/stream-assurance/ssrf.js';

describe('SSRF target validation', () => {
  it('allows a public IP / hostname', () => {
    expect(validateTarget({ connectHost: '23.55.1.1' })).toMatchObject({ ok: true, category: 'public' });
    expect(validateTarget({ connectHost: 'edge.example.com' })).toMatchObject({ ok: true, category: 'hostname' });
  });

  it('blocks loopback, link-local, metadata and private ranges by default', () => {
    expect(validateTarget({ connectHost: '127.0.0.1' })).toMatchObject({ ok: false, category: 'loopback' });
    expect(validateTarget({ connectHost: '::1' })).toMatchObject({ ok: false, category: 'loopback' });
    expect(validateTarget({ connectHost: '169.254.0.5' })).toMatchObject({ ok: false, category: 'link-local' });
    expect(validateTarget({ connectHost: '169.254.169.254' })).toMatchObject({ ok: false, category: 'metadata' });
    expect(validateTarget({ connectHost: '10.1.2.3' })).toMatchObject({ ok: false, category: 'private' });
    expect(validateTarget({ connectHost: '192.168.0.10' })).toMatchObject({ ok: false, category: 'private' });
    expect(validateTarget({ connectHost: 'fd00::1' })).toMatchObject({ ok: false, category: 'private' });
  });

  it('permits a blocked range ONLY for an approved managed-internal endpoint under policy', () => {
    expect(validateTarget({ connectHost: '127.0.0.1', managedInternal: true }, { allowManagedInternal: true })).toMatchObject({ ok: true });
    // managed-internal without the policy flag is still blocked
    expect(validateTarget({ connectHost: '127.0.0.1', managedInternal: true }, {})).toMatchObject({ ok: false });
    // policy flag without the endpoint flag is still blocked
    expect(validateTarget({ connectHost: '10.0.0.1' }, { allowManagedInternal: true })).toMatchObject({ ok: false });
  });

  it('enforces an explicit allowlist', () => {
    const policy = { allowHosts: ['edge-a.example.com'] };
    expect(validateTarget({ connectHost: 'edge-a.example.com' }, policy).ok).toBe(true);
    expect(validateTarget({ connectHost: 'evil.example.com' }, policy).ok).toBe(false);
  });
});

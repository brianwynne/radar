// Prefix WHOIS resolver (RIPEstat): parses the registration record, caches, and degrades to an
// empty result on failure — never throws.
import { describe, it, expect, vi } from 'vitest';
import { createRipestatWhoisResolver } from '../src/bgptools/prefix-whois.js';

const ripestatBody = {
  data: {
    records: [[
      { key: 'inetnum', value: '185.54.104.0 - 185.54.107.255' },
      { key: 'netname', value: 'RTE-NET' },
      { key: 'descr', value: 'Raidio Teilifis Eireann' },
      { key: 'country', value: 'IE' },
      { key: 'org', value: 'ORG-RTE1-RIPE' },
    ]],
    authorities: ['ripe'],
  },
};

describe('createRipestatWhoisResolver', () => {
  it('parses netname / description / organisation / country / registry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ripestatBody), { status: 200 })) as unknown as typeof fetch;
    const r = createRipestatWhoisResolver({ fetchImpl });
    const w = await r.lookup('185.54.104.0/22');
    expect(w).toMatchObject({ prefix: '185.54.104.0/22', netname: 'RTE-NET', description: 'Raidio Teilifis Eireann', organisation: 'ORG-RTE1-RIPE', country: 'IE', registry: 'ripe' });
    expect(r.source).toBe('ripestat');
  });

  it('caches a successful lookup (no second request)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ripestatBody), { status: 200 })) as unknown as typeof fetch;
    const r = createRipestatWhoisResolver({ fetchImpl });
    await r.lookup('185.54.104.0/22');
    await r.lookup('185.54.104.0/22');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('degrades to an empty result on a failed request (never throws)', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const r = createRipestatWhoisResolver({ fetchImpl });
    const w = await r.lookup('203.0.113.0/24');
    expect(w).toEqual({ prefix: '203.0.113.0/24', netname: null, description: null, organisation: null, country: null, registry: null });
  });
});

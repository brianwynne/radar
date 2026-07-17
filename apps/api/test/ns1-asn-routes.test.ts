// ASN breakdown route: resolves every ASN in a record to its network owner (injected resolver),
// groups by ASN with the delivery answers each is tagged in, derives platform from RDATA, and
// enforces ns1.detail.read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ns1ReadClient } from '../src/ns1/client.js';
import type { AsnResolver } from '../src/ns1/asn-resolver.js';

const RECORD = {
  zone: 'nsone.rte.ie',
  domain: 'live.nsone.rte.ie',
  type: 'CNAME',
  answers: [
    { id: 'eir', answer: ['liveedge.rte.ie'], meta: { note: 'Réalta EIR', weight: 220, asn: [5466] } },
    { id: 'eir-akamai', answer: ['live.rte.ie.akamaized.net'], meta: { note: 'Akamai EIR', weight: 45, asn: [5466] } },
    { id: 'lg', answer: ['liveedge.rte.ie'], meta: { note: 'Réalta LG', weight: 65, asn: [6830] } },
    { id: 'fastly-allother', answer: ['t.sni.global.fastly.net'], meta: { note: 'Fastly ALL OTHER', weight: 10 } }, // no asn → excluded
  ],
  filters: [],
};

const fakeClient: Ns1ReadClient = {
  listZones: async () => [{ zone: 'nsone.rte.ie' }],
  getZone: async () => RECORD,
  getRecord: async () => RECORD,
  getActivity: async () => [],
};

const fakeResolver: AsnResolver = {
  source: 'test',
  resolve: async (asns) => new Map(asns.map((a) => [a, a === 5466 ? 'EIRCOM Eircom Limited' : a === 6830 ? 'Liberty Global' : null])),
};

async function app(role: string, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    ns1Client: fakeClient,
    asnResolver: fakeResolver,
  });
  await a.ready();
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe('NS1 ASN breakdown', () => {
  it('resolves ASNs to owners, groups by ASN with tagged answers + platform, sorted ascending', async () => {
    const a = await app('VIEWING_ENGINEER');
    const res = await a.inject({ url: '/api/v1/ns1/asn-breakdown/nsone.rte.ie/live.nsone.rte.ie/CNAME' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('test');
    expect(body.asnCount).toBe(2); // 5466, 6830 — the no-ASN answer is excluded
    expect(body.rows.map((r: { asn: number }) => r.asn)).toEqual([5466, 6830]); // ascending

    const eir = body.rows[0];
    expect(eir.holder).toBe('EIRCOM Eircom Limited');
    expect(eir.resolved).toBe(true);
    // 5466 is tagged in two answers; platform derived from RDATA (Réalta / Akamai), not the note.
    expect(eir.tags).toHaveLength(2);
    expect(eir.tags.map((t: { platform: string }) => t.platform).sort()).toEqual(['Akamai', 'Réalta']);
    expect(eir.tags.find((t: { platform: string }) => t.platform === 'Réalta').weight).toBe(220);

    expect(body.rows[1]).toMatchObject({ asn: 6830, holder: 'Liberty Global', resolved: true });
    await a.close();
  });

  it('reports unresolved ASNs without failing', async () => {
    const client: Ns1ReadClient = { ...fakeClient, getRecord: async () => ({ ...RECORD, answers: [{ id: 'x', answer: ['x.fastly.net'], meta: { asn: [99999] } }] }) };
    const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'VIEWING_ENGINEER' }), { ns1Client: client, asnResolver: fakeResolver });
    await a.ready();
    const res = await a.inject({ url: '/api/v1/ns1/asn-breakdown/z/d/CNAME' });
    expect(res.json().rows[0]).toMatchObject({ asn: 99999, holder: null, resolved: false });
    expect(res.json().unresolvedCount).toBe(1);
    await a.close();
  });

  it('enforces ns1.detail.read (403 NOC viewer, 401 anonymous)', async () => {
    const viewer = await app('NOC_VIEWER');
    expect((await viewer.inject({ url: '/api/v1/ns1/asn-breakdown/z/d/CNAME' })).statusCode).toBe(403);
    await viewer.close();
    const anon = await app('VIEWING_ENGINEER', false);
    expect((await anon.inject({ url: '/api/v1/ns1/asn-breakdown/z/d/CNAME' })).statusCode).toBe(401);
    await anon.close();
  });
});

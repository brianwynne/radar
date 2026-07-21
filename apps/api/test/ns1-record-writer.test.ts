// Guarded NS1 create-record writer: the guards are the safety story, so they're tested hard.
import { describe, it, expect, vi } from 'vitest';
import { planCreate, planCloneRecord, matchesAllow, HttpNs1RecordWriter, DisabledNs1RecordWriter, Ns1WriteError, type CreateRecordInput } from '../src/ns1/record-writer.js';
import type { Ns1Config } from '../src/ns1/config.js';

const cfg = (over: Partial<Ns1Config> = {}): Ns1Config => ({
  mode: 'live', baseUrl: 'https://api.nsone.net/v1', apiKey: 'k', writeApiKey: 'k',
  requestTimeoutMs: 5000, maxRetries: 2, cacheTtlSeconds: 30,
  writeEnabled: true, writeAllow: ['livetest.rte.ie', '*.livetest.rte.ie'],
  ...over,
});
const A = (over: Partial<CreateRecordInput> = {}): CreateRecordInput => ({ zone: 'rte.ie', domain: 'livetest.rte.ie', type: 'A', answers: ['185.54.104.4'], ttl: 30, ...over });

describe('matchesAllow', () => {
  it('matches exact + *.suffix, case/dot-insensitive', () => {
    expect(matchesAllow('livetest.rte.ie', ['livetest.rte.ie'])).toBe(true);
    expect(matchesAllow('LIVETEST.rte.ie.', ['livetest.rte.ie'])).toBe(true);
    expect(matchesAllow('a.b.test.nsone.rte.ie', ['*.test.nsone.rte.ie'])).toBe(true);
    expect(matchesAllow('test.nsone.rte.ie', ['*.test.nsone.rte.ie'])).toBe(true); // the suffix itself
    expect(matchesAllow('livebase.nsone.rte.ie', ['*.test.nsone.rte.ie', 'livetest.rte.ie'])).toBe(false);
  });
});

describe('planCreate guards', () => {
  it('allows an in-allow-list test record and builds the exact NS1 PUT payload', () => {
    const p = planCreate(cfg(), A());
    expect(p.allowed).toBe(true);
    expect(p.request).toEqual({ method: 'PUT', path: '/zones/rte.ie/livetest.rte.ie/A', body: { zone: 'rte.ie', domain: 'livetest.rte.ie', type: 'A', answers: [{ answer: ['185.54.104.4'] }], ttl: 30 } });
  });

  it('BLOCKS when write is disabled (default) even with a valid record', () => {
    expect(planCreate(cfg({ writeEnabled: false }), A()).allowed).toBe(false);
  });

  it('BLOCKS a protected live record even if it were allow-listed', () => {
    const p = planCreate(cfg({ writeAllow: ['*.nsone.rte.ie'] }), A({ domain: 'livebase.nsone.rte.ie', type: 'CNAME', answers: ['liveedge.rte.ie'] }));
    expect(p.allowed).toBe(false);
    expect(p.blockedReason).toMatch(/protected live record/i);
  });

  it('BLOCKS a name outside the allow-list', () => {
    expect(planCreate(cfg(), A({ domain: 'anything.rte.ie' })).allowed).toBe(false);
  });

  it('BLOCKS a domain that is not inside its zone', () => {
    expect(planCreate(cfg({ writeAllow: ['*.example.com'] }), A({ zone: 'rte.ie', domain: 'x.example.com' })).allowed).toBe(false);
  });

  it('validates answers by type', () => {
    expect(planCreate(cfg(), A({ type: 'A', answers: ['not-an-ip'] })).allowed).toBe(false);
    expect(planCreate(cfg(), A({ type: 'CNAME', answers: ['a.rte.ie', 'b.rte.ie'] })).allowed).toBe(false); // >1 CNAME target
    expect(planCreate(cfg(), A({ type: 'CNAME', answers: ['liveedge.rte.ie'] })).allowed).toBe(true);
    expect(planCreate(cfg(), A({ type: 'AAAA', answers: ['2001:bb0::1'] })).allowed).toBe(true);
  });

  it('bounds the TTL and warns below 30s', () => {
    expect(planCreate(cfg(), A({ ttl: 0 })).allowed).toBe(false);
    expect(planCreate(cfg(), A({ ttl: 700000 })).allowed).toBe(false);
    expect(planCreate(cfg(), A({ ttl: 10 })).warnings.join(' ')).toMatch(/floored up/i);
  });

  it('needs live mode + a write key', () => {
    expect(planCreate(cfg({ mode: 'mock' }), A()).allowed).toBe(false);
    expect(planCreate(cfg({ writeApiKey: undefined }), A()).allowed).toBe(false);
  });
});

describe('planCloneRecord', () => {
  const SRC = { id: 'abc', zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME', ttl: 300, answers: [{ answer: ['liveedge.rte.ie'] }], filters: [{ filter: 'up' }, { filter: 'shed_load' }], use_client_subnet: true };

  it('clones a real steering record onto the test target, retargeting + overriding TTL', () => {
    const p = planCloneRecord(cfg(), { zone: 'rte.ie', domain: 'livetest.rte.ie', ttl: 30 }, SRC);
    expect(p.allowed).toBe(true);
    expect(p.request.body).toMatchObject({ zone: 'rte.ie', domain: 'livetest.rte.ie', type: 'CNAME', ttl: 30, answers: [{ answer: ['liveedge.rte.ie'] }], filters: [{ filter: 'up' }, { filter: 'shed_load' }], use_client_subnet: true });
    expect(p.request.body).not.toHaveProperty('id'); // NS1 read-only field dropped
    expect(p.warnings.join(' ')).toMatch(/steering chain/i); // filters carried → reviewed
  });

  it('inherits the source TTL when no override is given', () => {
    expect(planCloneRecord(cfg(), { zone: 'rte.ie', domain: 'livetest.rte.ie' }, SRC).request.body.ttl).toBe(300);
  });

  it('BLOCKS cloning onto a protected live record', () => {
    expect(planCloneRecord(cfg({ writeAllow: ['*.nsone.rte.ie'] }), { zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie' }, SRC).allowed).toBe(false);
  });

  it('BLOCKS cloning onto a name outside the allow-list', () => {
    expect(planCloneRecord(cfg(), { zone: 'rte.ie', domain: 'whatever.rte.ie' }, SRC).allowed).toBe(false);
  });

  it('BLOCKS when the source could not be read', () => {
    expect(planCloneRecord(cfg(), { zone: 'rte.ie', domain: 'livetest.rte.ie' }, {}).allowed).toBe(false);
    expect(planCloneRecord(cfg(), { zone: 'rte.ie', domain: 'livetest.rte.ie' }, null).allowed).toBe(false);
  });
});

describe('HttpNs1RecordWriter.apply', () => {
  it('PUTs an allowed record with the write key and flags provenance as a write', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'rec1' }), { status: 200 }));
    const w = new HttpNs1RecordWriter(cfg(), fetchImpl as unknown as typeof fetch);
    const res = await w.apply(A());
    expect(res.created).toBe(true);
    expect(res.provenance).toMatchObject({ readOnly: false, write: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.nsone.net/v1/zones/rte.ie/livetest.rte.ie/A');
    expect((init as RequestInit).method).toBe('PUT');
    expect(((init as RequestInit).headers as Record<string, string>)['X-NSONE-Key']).toBe('k');
  });

  it('refuses to PUT a blocked record (no network call)', async () => {
    const fetchImpl = vi.fn();
    const w = new HttpNs1RecordWriter(cfg(), fetchImpl as unknown as typeof fetch);
    await expect(w.apply(A({ domain: 'livebase.nsone.rte.ie', type: 'CNAME', answers: ['liveedge.rte.ie'] }))).rejects.toBeInstanceOf(Ns1WriteError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('disabled writer never writes but still plans (dry-run)', async () => {
    const w = new DisabledNs1RecordWriter(cfg({ writeEnabled: false }));
    expect(w.writeEnabled()).toBe(false);
    expect(w.plan(A()).allowed).toBe(false); // write disabled → plan blocked
    await expect(w.apply(A())).rejects.toBeInstanceOf(Ns1WriteError);
  });
});

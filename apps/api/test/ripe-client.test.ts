// RIPEstat client: response validation, caching, timeout/HTTP/parse error classification, bounded
// retry, and the sourceapp + User-Agent request contract. Injected fetch — never hits live RIPE.
import { describe, it, expect, vi } from 'vitest';
import { createRipestatClient, RipeError } from '../src/ripe/client.js';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const NOW = Date.parse('2026-07-24T09:00:00Z');

describe('createRipestatClient', () => {
  it('parses the data envelope and stamps fetchedAt', async () => {
    const fetchImpl = vi.fn(async () => ok({ visibility: { v4: { ris_peers_seeing: 320, total_ris_peers: 325 } } })) as unknown as typeof fetch;
    const c = createRipestatClient({ fetchImpl, now: () => NOW });
    const r = await c.routingStatus('89.207.56.0/21');
    expect(r.data.visibility?.v4?.ris_peers_seeing).toBe(320);
    expect(r.fetchedAt).toBe('2026-07-24T09:00:00.000Z');
  });

  it('sends an identifying User-Agent and a sourceapp param', async () => {
    let seenUrl = ''; let seenUa = '';
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { seenUrl = url; seenUa = (init.headers as Record<string, string>)['User-Agent']; return ok({}); }) as unknown as typeof fetch;
    await createRipestatClient({ fetchImpl, userAgent: 'RADAR/test' }).rpkiValidation(41073, '89.207.56.0/21');
    expect(seenUrl).toContain('sourceapp=radar');
    expect(seenUrl).toContain('resource=AS41073');
    expect(seenUa).toBe('RADAR/test');
  });

  it('caches within the TTL (one request for repeated calls)', async () => {
    const fetchImpl = vi.fn(async () => ok({ x: 1 })) as unknown as typeof fetch;
    const c = createRipestatClient({ fetchImpl, cacheTtlMs: 60_000, now: () => NOW });
    await c.visibility('p'); await c.visibility('p');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('classifies HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 503 })) as unknown as typeof fetch;
    await expect(createRipestatClient({ fetchImpl, retries: 0 }).routingStatus('p')).rejects.toMatchObject({ code: 'RIPE_HTTP' });
  });

  it('classifies a non-JSON body as a parse error (no retry)', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(createRipestatClient({ fetchImpl, retries: 3 }).routingStatus('p')).rejects.toMatchObject({ code: 'RIPE_PARSE' });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // parse errors are not retried
  });

  it('retries a transient failure then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => { n += 1; if (n === 1) return new Response('e', { status: 500 }); return ok({ ok: true }); }) as unknown as typeof fetch;
    const r = await createRipestatClient({ fetchImpl, retries: 2 }).lookingGlass('p');
    expect(r.data).toMatchObject({ ok: true });
    expect(n).toBe(2);
  });

  it('rejects a missing data envelope', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch;
    await expect(createRipestatClient({ fetchImpl, retries: 0 }).routingStatus('p')).rejects.toBeInstanceOf(RipeError);
  });
});

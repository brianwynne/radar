// Redirect-following is unit-tested by mocking the transport probe (a real loopback server would be
// refused by the SSRF guard, correctly). This drives the exact RTÉ One chain: tokenised www.rte.ie
// entry → 302 DAI create → 302 DAI session manifest → 200.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probe } from '../../src/stream-assurance/probe.js';
import { fetchFollowingRedirects } from '../../src/stream-assurance/follow.js';

vi.mock('../../src/stream-assurance/probe.js', () => ({ probe: vi.fn() }));
const probeMock = vi.mocked(probe);

const redirectTo = (location: string) => ({ status: 302, headers: { location }, body: new Uint8Array(), truncated: false, timingMs: 1, tls: { used: true, sni: null } });
const ok = (body: string) => ({ status: 200, headers: { 'content-type': 'application/dash+xml' }, body: new TextEncoder().encode(body), truncated: false, timingMs: 1, tls: { used: true, sni: null } });

beforeEach(() => probeMock.mockReset());

describe('fetchFollowingRedirects', () => {
  it('follows the cross-host DAI chain and returns the final manifest', async () => {
    const ENTRY = 'https://www.rte.ie/player-live/channel/live/a/vc11/vc11.isml/.mpd?token1=abc';
    const CREATE = 'https://dai.google.com/linear/dash/event/OzeyI_8XRUGhaubXc0ZZNQ/manifest.mpd?cust_params=x';
    const SESSION = 'https://dai.google.com/linear/dash/pa/event/OzeyI_8XRUGhaubXc0ZZNQ/stream/abc123/manifest.mpd';
    // The chain is deterministic: entry → 302 create → 302 session → 200.
    probeMock
      .mockResolvedValueOnce(redirectTo(CREATE))
      .mockResolvedValueOnce(redirectTo(SESSION))
      .mockResolvedValueOnce(ok('<MPD/>'));

    const res = await fetchFollowingRedirects(ENTRY, {});
    // The three hops were requested in order.
    expect(probeMock.mock.calls.map((c) => (c[0] as { publicUrl: string }).publicUrl)).toEqual([ENTRY, CREATE, SESSION]);
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe(SESSION);
    expect(res.redirects).toEqual([ENTRY, CREATE]);
    expect(new TextDecoder().decode(res.body)).toBe('<MPD/>');
    // Each hop dialled its OWN host (direct fetch, not pinned).
    expect(probeMock.mock.calls.map((c) => (c[0] as { connectHost: string }).connectHost)).toEqual(['www.rte.ie', 'dai.google.com', 'dai.google.com']);
  });

  it('re-runs the SSRF guard on every hop — a redirect to a private host is refused', async () => {
    probeMock.mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'));
    await expect(fetchFollowingRedirects('https://www.rte.ie/x.mpd', {})).rejects.toThrow(/SSRF/i);
  });

  it('caps the redirect count', async () => {
    probeMock.mockResolvedValue(redirectTo('https://a.example/next'));
    await expect(fetchFollowingRedirects('https://a.example/start', {}, { maxRedirects: 3 })).rejects.toThrow(/too many redirects/i);
  });
});

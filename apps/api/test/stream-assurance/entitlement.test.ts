// The entitlement resolver is unit-tested by mocking the redirect-following fetch (real feeds are
// external + the SSRF guard would refuse loopback). We drive the exact RTÉ chain: station feed →
// listings mediaPid → SMIL → (redirecting) entry URL → discovered manifest.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchFollowingRedirects } from '../../src/stream-assurance/follow.js';
import { listRteChannels, resolveChannel, DEFAULT_RTE_FEED_CONFIG } from '../../src/stream-assurance/entitlement.js';

vi.mock('../../src/stream-assurance/follow.js', () => ({ fetchFollowingRedirects: vi.fn() }));
const followMock = vi.mocked(fetchFollowingRedirects);

const CFG = DEFAULT_RTE_FEED_CONFIG;
const enc = (s: string) => new TextEncoder().encode(s);
const resp = (body: string, finalUrl: string, status = 200) => ({ status, headers: {}, body: enc(body), finalUrl, redirects: [] });

const STATION_FEED = JSON.stringify({ entries: [
  { guid: 'RTEONE', description: 'RTÉ One', 'plstation$callSign': 'RTEONE', 'plstation$isVirtual': false, 'rte$google-ssai-dash': 'OzeyKEY' },
  { guid: 'RTENewsChannel', description: 'RTÉ News', 'plstation$callSign': 'RTENewsNow', 'plstation$isVirtual': false },
] });
// Schedules feed shape: a channel schedule whose listings carry start/end + mediaPid. The one
// bracketing nowMs (1785240000000) is the live media.
const SCHEDULES = JSON.stringify({ entries: [{ 'plchannelschedule$listings': [
  { 'pllisting$startTime': 1785230000000, 'pllisting$endTime': 1785239000000, 'rtelisting$mediaPid': 'ended-programme' },
  { 'pllisting$startTime': 1785239000000, 'pllisting$endTime': 1785241000000, 'rtelisting$mediaPid': 'be90cf629ee8f4a77e46959febb9e000' },
] }] });
const SMIL = `<smil><body><seq>
  <ref src="https://pubads.g.doubleclick.net/gampad/live/ads?x=1" tags="preroll"></ref>
  <video src="https://www.rte.ie/player-live/channel/live/a/vc11/vc11.isml/.mpd?ip=1.2.3.4&amp;token1=t"/>
  <ref src="https://www.rte.ie/player-live/channel/live/a/vc11/vc11.isml/.mpd?ip=1.2.3.4&amp;token1=t" type="application/dash+xml"/>
</seq></body></smil>`;
const MPD = `<?xml version="1.0"?><MPD type="dynamic"><BaseURL>https://live.rte.ie/live/b/vc11/vc11.isml/</BaseURL><BaseURL>dash/</BaseURL>
  <Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate media="vc11-$RepresentationID$-$Time$.dash" initialization="vc11-$RepresentationID$.dash"><SegmentTimeline><S t="100" d="10" r="1"/></SegmentTimeline></SegmentTemplate>
    <Representation id="video=6000000" bandwidth="6000000" width="1920" height="1080"/>
  </AdaptationSet></Period></MPD>`;
const FINAL_MANIFEST = 'https://dai.google.com/linear/dash/pa/event/OzeyKEY/stream/sess/manifest.mpd';

beforeEach(() => followMock.mockReset());

describe('entitlement resolver', () => {
  it('lists channels and classifies DAI vs direct delivery', async () => {
    followMock.mockResolvedValueOnce(resp(STATION_FEED, 'x'));
    const chans = await listRteChannels(CFG, {});
    expect(chans).toHaveLength(2);
    expect(chans[0]).toMatchObject({ callSign: 'RTEONE', delivery: 'dai', daiKey: 'OzeyKEY' });
    expect(chans[1]).toMatchObject({ callSign: 'RTENewsNow', delivery: 'direct', daiKey: null });
  });

  it('resolves a channel through mediaPid → SMIL → redirect → discovered manifest', async () => {
    followMock
      .mockResolvedValueOnce(resp(SCHEDULES, 'schedules'))              // listings byCallSign → mediaPid
      .mockResolvedValueOnce(resp(SMIL, 'smil'))                     // SMIL resolve → entry URL
      .mockResolvedValueOnce(resp(MPD, FINAL_MANIFEST));            // entry URL follows redirects → final manifest

    const r = await resolveChannel('RTEONE', CFG, {}, 1785240000000);
    expect(r.mediaPid).toBe('be90cf629ee8f4a77e46959febb9e000');
    expect(r.entryUrl).toContain('www.rte.ie/player-live'); // signed entry (token decoded, &amp; → &)
    expect(r.entryUrl).toContain('token1=t');
    expect(r.finalManifestUrl).toBe(FINAL_MANIFEST);
    // The discovered manifest resolved BaseURL back to the RTÉ CDN + derived the init URL.
    expect(r.manifest.baseUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/');
    const top = r.manifest.representations.find((x) => x.id === 'video=6000000')!;
    expect(top.initUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-video=6000000.dash');
    expect(r.adTags.some((u) => u.includes('doubleclick'))).toBe(true);

    // The SMIL was requested for the right mediaPid + DASH format.
    const smilCall = followMock.mock.calls[1][0];
    expect(smilCall).toContain('/s/1uC-gC/media/be90cf629ee8f4a77e46959febb9e000');
    expect(smilCall).toContain('format=SMIL');
  });

  it('errors clearly when the channel has no current media', async () => {
    followMock.mockResolvedValueOnce(resp(JSON.stringify({ entries: [] }), 'listings'));
    await expect(resolveChannel('RTEONE', CFG, {}, 1785240000000)).rejects.toThrow(/no current media/i);
  });
});

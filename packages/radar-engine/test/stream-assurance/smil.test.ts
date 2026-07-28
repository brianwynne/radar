import { describe, it, expect } from 'vitest';
import { parseSmil } from '../../src/stream-assurance/index.js';

// Direct-CDN channel (RTÉ News): a preroll ad <ref> + the signed live.rte.ie DASH manifest. Mirrors
// the real thePlatform SMIL response (entities encoded as on the wire).
const SMIL_DIRECT = `<smil xmlns="http://www.w3.org/2005/SMIL21/Language">
<head><meta name="startingBitrate" content="2500000"/></head>
<body><seq>
  <ref src="https://pubads.g.doubleclick.net/gampad/live/ads?correlator=522874&amp;iu=%2F3014%2FRTE_Player_Live%2FDesktop_Web&amp;output=vmap" no-skip="true" tags="preroll"></ref>
  <switch>
    <video src="https://live.rte.ie/live/a/channel3/channel3.isml/.mpd?dvr_window_length=30&amp;expiry=1785272400&amp;ip=64.43.20.219&amp;token1=829315d8" system-bitrate="0"/>
    <ref src="https://live.rte.ie/live/a/channel3/channel3.isml/.mpd?dvr_window_length=30&amp;expiry=1785272400&amp;ip=64.43.20.219&amp;token1=829315d8" title="Latest News" guid="RTENewsChannel_NN0001" type="application/dash+xml" security="commonEncryption"></ref>
  </switch>
</seq></body></smil>`;

// DAI channel (RTÉ One): the entry URL is a tokenised www.rte.ie path that later redirects to DAI.
const SMIL_DAI = `<smil><body><seq>
  <ref src="https://pubads.g.doubleclick.net/gampad/live/ads?correlator=1" tags="preroll"></ref>
  <switch>
    <video src="https://www.rte.ie/player-live/channel/live/a/vc11/vc11.isml/.mpd?expiry=1785271122&amp;ip=64.43.20.219&amp;token1=abc" system-bitrate="0"/>
    <ref src="https://www.rte.ie/player-live/channel/live/a/vc11/vc11.isml/.mpd?expiry=1785271122&amp;ip=64.43.20.219&amp;token1=abc" type="application/dash+xml" security="commonEncryption"></ref>
  </switch>
</seq></body></smil>`;

describe('parseSmil', () => {
  it('extracts the signed DASH manifest and ignores the preroll ad tag', () => {
    const r = parseSmil(SMIL_DIRECT);
    expect(r.dashManifestUrl).toBe('https://live.rte.ie/live/a/channel3/channel3.isml/.mpd?dvr_window_length=30&expiry=1785272400&ip=64.43.20.219&token1=829315d8');
    expect(r.media).toHaveLength(1); // the <video> and its sibling <ref> dedupe to one manifest
    expect(r.media[0]).toMatchObject({ protocol: 'dash', security: 'commonEncryption', guid: 'RTENewsChannel_NN0001' });
    expect(r.adTags.some((u) => u.includes('doubleclick'))).toBe(true);
    expect(r.hlsManifestUrl).toBeNull();
  });

  it('decodes &amp; so the token URL is usable', () => {
    expect(parseSmil(SMIL_DIRECT).dashManifestUrl).not.toContain('&amp;');
  });

  it('returns the DAI entry URL for a DAI channel (redirect resolution happens later)', () => {
    const r = parseSmil(SMIL_DAI);
    expect(r.dashManifestUrl).toBe('https://www.rte.ie/player-live/channel/live/a/vc11/vc11.isml/.mpd?expiry=1785271122&ip=64.43.20.219&token1=abc');
    expect(r.adTags).toHaveLength(1);
  });

  it('handles an empty / manifest-less SMIL', () => {
    const r = parseSmil('<smil><body><seq></seq></body></smil>');
    expect(r.dashManifestUrl).toBeNull();
    expect(r.media).toEqual([]);
  });
});

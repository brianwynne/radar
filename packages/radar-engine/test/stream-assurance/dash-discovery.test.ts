import { describe, it, expect } from 'vitest';
import { discoverDashSegments, latestSegmentTime } from '../../src/stream-assurance/index.js';

// Mirrors the real ad-stitched RTÉ manifest: a DAI wrapper whose BaseURL redirects the media back to
// live.rte.ie, Unified Streaming $RepresentationID$/$Time$ templates, video ladder + trick-play + audio.
const MANIFEST_URL = 'https://dai.google.com/linear/dash/pa/event/E/stream/S:GRQ/manifest.mpd';
const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" publishTime="2026-07-28T11:38:21Z" minimumUpdatePeriod="PT2S">
  <BaseURL>https://live.rte.ie/live/b/vc11/vc11.isml/</BaseURL>
  <BaseURL>dash/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="df163382-1ddd-fdd5-bec9-822c1ec0f052"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <SegmentTemplate timescale="600" media="vc11-$RepresentationID$-$Time$.dash" initialization="vc11-$RepresentationID$.dash">
        <SegmentTimeline><S t="1071143194344" d="2304" r="7"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation width="1920" height="1080" codecs="avc1.640028" id="video=6000000" bandwidth="6000000"/>
      <Representation width="416" height="234" codecs="avc1.64000D" id="video=144960" bandwidth="144960"/>
      <Representation width="1920" height="1080" codecs="avc1.640028" id="video=6000000(mode=trik)" bandwidth="384988"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="ga">
      <SegmentTemplate timescale="48000" media="vc11-$RepresentationID$-$Time$.dash" initialization="vc11-$RepresentationID$.dash">
        <SegmentTimeline><S t="85691455547520" d="184320" r="7"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation codecs="mp4a.40.2" id="audio=128000" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('discoverDashSegments', () => {
  const d = discoverDashSegments(MPD, MANIFEST_URL);

  it('resolves the BaseURL chain back to the CDN origin', () => {
    expect(d.baseUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/');
    expect(d.presentation).toBe('dynamic');
  });

  it('derives absolute init URLs per representation from $RepresentationID$', () => {
    const top = d.representations.find((r) => r.id === 'video=6000000')!;
    expect(top.initUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-video=6000000.dash');
    expect(top.contentType).toBe('video');
    expect(top.bandwidth).toBe(6000000);
    expect(top.width).toBe(1920);
    expect(top.trickPlay).toBe(false);
  });

  it('derives the current media-fragment URL from the SegmentTimeline live edge', () => {
    const top = d.representations.find((r) => r.id === 'video=6000000')!;
    // Last segment start = t + d*r = 1071143194344 + 2304*7 = 1071143210472.
    expect(top.latestMediaUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-video=6000000-1071143210472.dash');
  });

  it('flags trick-play and carries audio language + its own timeline', () => {
    expect(d.representations.find((r) => r.id === 'video=6000000(mode=trik)')!.trickPlay).toBe(true);
    const audio = d.representations.find((r) => r.id === 'audio=128000')!;
    expect(audio.contentType).toBe('audio');
    expect(audio.lang).toBe('ga');
    expect(audio.latestMediaUrl).toBe('https://live.rte.ie/live/b/vc11/vc11.isml/dash/vc11-audio=128000-85691456837760.dash');
  });

  it('exposes the DRM identity from the manifest', () => {
    expect(d.drm.defaultKid).toBe('df163382-1ddd-fdd5-bec9-822c1ec0f052');
    expect(d.drm.systems.map((s) => s.systemId)).toContain('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
  });

  it('latestSegmentTime handles repeat counts', () => {
    expect(latestSegmentTime('<SegmentTimeline><S t="100" d="10" r="3"/></SegmentTimeline>')).toBe(130);
    expect(latestSegmentTime('<SegmentTimeline><S t="100" d="10"/><S d="10" r="1"/></SegmentTimeline>')).toBe(120);
    expect(latestSegmentTime('<SegmentTimeline></SegmentTimeline>')).toBeNull();
  });
});

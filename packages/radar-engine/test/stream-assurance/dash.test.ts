import { describe, it, expect } from 'vitest';
import { extractDashManifest, parseIso8601Duration } from '../../src/stream-assurance/index.js';

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"
     publishTime="2026-07-27T21:00:00Z" minimumUpdatePeriod="PT6S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs"
                         cenc:default_KID="11111111-2222-3333-4444-555555555555"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('extractDashManifest (DRM + freshness)', () => {
  it('extracts presentation type, freshness and DRM identity', () => {
    const info = extractDashManifest(MPD);
    expect(info.presentation).toBe('dynamic');
    expect(info.minimumUpdatePeriodSeconds).toBe(6);
    expect(info.publishTime).toBe('2026-07-27T21:00:00Z');
    expect(info.profiles).toContain('urn:mpeg:dash:profile:isoff-live:2011');
    expect(info.drm.defaultKid).toBe('11111111-2222-3333-4444-555555555555');
    const systems = info.drm.systems.map((s) => s.systemId);
    expect(systems).toContain('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'); // Widevine
    expect(systems).toContain('9a04f079-9840-4286-ab92-e65be0885f95'); // PlayReady
    // the mp4protection element is not counted as a DRM system
    expect(systems).not.toContain('urn:mpeg:dash:mp4protection:2011');
  });

  it('parses xs:duration values', () => {
    expect(parseIso8601Duration('PT6S')).toBe(6);
    expect(parseIso8601Duration('PT1M30S')).toBe(90);
    expect(parseIso8601Duration('PT2H')).toBe(7200);
    expect(parseIso8601Duration(null)).toBeNull();
  });
});

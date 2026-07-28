import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist, parseMediaPlaylist, validateMaster, validateMedia } from '../../src/stream-assurance/index.js';

describe('HLS conformance validators', () => {
  it('a well-formed master + media yield no findings', () => {
    const master = parseMasterPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="a.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f",RESOLUTION=1280x720,AUDIO="aud"
v.m3u8
`);
    expect(validateMaster(master)).toHaveLength(0);
    const media = parseMediaPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
s1.m4s
#EXT-X-ENDLIST
`);
    expect(validateMedia(media, { live: false })).toHaveLength(0);
  });

  it('master: missing BANDWIDTH and an undefined AUDIO group are flagged (SA-HLS-002)', () => {
    const m = parseMasterPlaylist(`#EXTM3U
#EXT-X-STREAM-INF:CODECS="avc1.64001f",AUDIO="missing"
v.m3u8
`);
    const ids = validateMaster(m).map((f) => f.ruleId);
    expect(ids).toContain('SA-HLS-002');
    expect(validateMaster(m).some((f) => /missing BANDWIDTH/.test(f.explanation))).toBe(true);
    expect(validateMaster(m).some((f) => /group "missing"/.test(f.explanation))).toBe(true);
  });

  it('media: over-long segment, PDT regression, missing ENDLIST, and unsigned key are flagged', () => {
    const m = parseMediaPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-PROGRAM-DATE-TIME:2026-07-27T21:00:10Z
#EXTINF:6.0,
s1.m4s
#EXT-X-PROGRAM-DATE-TIME:2026-07-27T21:00:00Z
#EXTINF:9.0,
s2.m4s
`);
    const findings = validateMedia(m, { live: false });
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('SA-HLS-004'); // EXT-X-KEY without URI
    expect(findings.some((f) => /exceeds TARGETDURATION/.test(f.explanation))).toBe(true); // 9s > 6s
    expect(findings.some((f) => /regresses/.test(f.explanation))).toBe(true); // PDT went backwards
    expect(findings.some((f) => /EXT-X-ENDLIST/.test(f.explanation))).toBe(true); // VOD without endlist
  });

  it('never surfaces key material — only key signalling', () => {
    const m = parseMediaPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://opaque",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
s1.m4s
#EXT-X-ENDLIST
`);
    const json = JSON.stringify(validateMedia(m, { live: false }));
    expect(json).not.toMatch(/skd:\/\/opaque/); // the key URI is not echoed into findings
  });
});

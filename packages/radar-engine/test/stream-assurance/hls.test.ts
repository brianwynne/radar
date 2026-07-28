import { describe, it, expect } from 'vitest';
import { parseAttributes, parseMasterPlaylist, parseMediaPlaylist, parsePlaylist, isMasterPlaylist } from '../../src/stream-assurance/index.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=50,AUDIO="aud"
video/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aud"
video/720.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXT-X-PROGRAM-DATE-TIME:2026-07-27T21:00:00Z
#EXTINF:6.0,
seg1.m4s
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
seg2.m4s
#EXT-X-ENDLIST
`;

describe('HLS parsing', () => {
  it('parseAttributes keeps commas inside quoted values', () => {
    const a = parseAttributes('BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080');
    expect(a.BANDWIDTH).toBe('5000000');
    expect(a.CODECS).toBe('avc1.640028,mp4a.40.2');
    expect(a.RESOLUTION).toBe('1920x1080');
  });

  it('parses a master playlist (variants + renditions)', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    const m = parseMasterPlaylist(MASTER);
    expect(m.version).toBe(7);
    expect(m.independentSegments).toBe(true);
    expect(m.variants).toHaveLength(2);
    expect(m.variants[0]).toMatchObject({ bandwidth: 5000000, averageBandwidth: 4500000, frameRate: 50, audioGroup: 'aud', uri: 'video/1080.m3u8' });
    expect(m.variants[0].codecs).toEqual(['avc1.640028', 'mp4a.40.2']);
    expect(m.variants[0].resolution).toEqual({ width: 1920, height: 1080 });
    expect(m.renditions[0]).toMatchObject({ type: 'AUDIO', groupId: 'aud', language: 'en', isDefault: true, autoselect: true, uri: 'audio/en.m3u8' });
    expect(m.warnings).toHaveLength(0);
  });

  it('parses a media playlist (segments, map, key signalling, discontinuity, endlist)', () => {
    expect(isMasterPlaylist(MEDIA)).toBe(false);
    const m = parseMediaPlaylist(MEDIA);
    expect(m.targetDuration).toBe(6);
    expect(m.mediaSequence).toBe(100);
    expect(m.map).toBe('init.mp4');
    expect(m.endList).toBe(true);
    expect(m.segments).toHaveLength(2);
    expect(m.segments[0]).toMatchObject({ duration: 6, uri: 'seg1.m4s', programDateTime: '2026-07-27T21:00:00Z' });
    expect(m.segments[1].discontinuity).toBe(true);
    expect(m.keys[0]).toMatchObject({ method: 'SAMPLE-AES', uri: 'skd://key-id', keyFormat: 'com.apple.streamingkeydelivery' });
    expect(m.lowLatency).toBe(false);
  });

  it('detects Low-Latency HLS tags', () => {
    const ll = parseMediaPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-PART-INF:PART-TARGET=1.0
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3.0
#EXTINF:4.0,
seg1.m4s
`);
    expect(ll.lowLatency).toBe(true);
    expect(ll.partTargetDuration).toBe(1);
  });

  it('parsePlaylist dispatches master vs media', () => {
    expect(parsePlaylist(MASTER).isMaster).toBe(true);
    expect(parsePlaylist(MEDIA).isMaster).toBe(false);
  });
});

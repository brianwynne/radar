// End-to-end manifest observation over real HTTP: a mock CDN serves a STALE dynamic MPD and an HLS
// pair whose DRM system (FairPlay) disagrees with the MPD (Widevine). observeManifests fetches via
// the connect-to probe, parses + validates, and cross-compares → SA-DASH-001 + SA-XDRM-001.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { observeManifests } from '../../src/stream-assurance/manifests.js';

const MPD = `<?xml version="1.0"?>
<MPD type="dynamic" publishTime="2020-01-01T00:00:00Z" minimumUpdatePeriod="PT6S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period><AdaptationSet mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="11111111-2222-3333-4444-555555555555"/>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
  </AdaptationSet></Period>
</MPD>`;
const HLS_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f"
media.m3u8
`;
const HLS_MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://opaque",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
s1.m4s
`;

let server: http.Server; let port: number;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/live.mpd') { res.writeHead(200, { 'content-type': 'application/dash+xml' }); res.end(MPD); }
    else if (req.url === '/hls/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(HLS_MASTER); }
    else if (req.url === '/hls/media.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(HLS_MEDIA); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('observeManifests (fetch → parse → validate → cross-protocol)', () => {
  it('flags a stale MPD and a DASH/HLS DRM-system mismatch', async () => {
    const { findings } = await observeManifests(
      { dashMpdUrl: `http://live.rte.ie/live.mpd`, hlsMasterUrl: `http://live.rte.ie/hls/master.m3u8`, hlsMediaUrl: `http://live.rte.ie/hls/media.m3u8` },
      { connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.ie', managedInternal: true },
      { allowManagedInternal: true },
      Date.parse('2026-07-28T00:00:00Z'),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('SA-DASH-001'); // dynamic MPD published in 2020 → stale
    expect(ids).toContain('SA-XDRM-001'); // DASH Widevine vs HLS FairPlay
    // No key material leaks into findings.
    expect(JSON.stringify(findings)).not.toMatch(/skd:\/\/opaque/);
  });

  it('returns nothing when the target is blocked by SSRF policy', async () => {
    const { findings } = await observeManifests(
      { dashMpdUrl: `http://live.rte.ie/live.mpd` },
      { connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.ie' }, // not managed-internal
      { allowManagedInternal: true },
      Date.now(),
    );
    expect(findings).toHaveLength(0);
  });
});

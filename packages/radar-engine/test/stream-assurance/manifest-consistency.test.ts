import { describe, it, expect } from 'vitest';
import { compareManifestsAcrossCdns, extractDashManifest, parseMasterPlaylist, type EndpointManifest } from '../../src/stream-assurance/index.js';

// Same live service, fetched through several CDNs. The reference is current; candidates may have
// cached an older manifest generation (different KID / ladder / publishTime).
const mpd = (opts: { kid: string; publishTime: string; bands: number[] }): string => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" publishTime="${opts.publishTime}" minimumUpdatePeriod="PT6S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="${opts.kid}"/>
      ${opts.bands.map((b) => `<Representation id="v${b}" bandwidth="${b}"/>`).join('\n      ')}
    </AdaptationSet>
  </Period>
</MPD>`;

const master = (bands: number[]): string =>
  '#EXTM3U\n' + bands.map((b) => `#EXT-X-STREAM-INF:BANDWIDTH=${b},CODECS="avc1.640028"\nv${b}.m3u8`).join('\n') + '\n';

const KID_A = '11111111-2222-3333-4444-555555555555';
const KID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BANDS = [800000, 2400000, 6000000];

const endpoint = (id: string, role: 'reference' | 'candidate', dashXml: string | null, masterM3u8: string | null): EndpointManifest => ({
  endpointId: id, provider: id === 'fastly' ? 'fastly' : 'akamai', role,
  dash: dashXml ? extractDashManifest(dashXml) : null,
  hlsMaster: masterM3u8 ? parseMasterPlaylist(masterM3u8) : null,
});

describe('compareManifestsAcrossCdns', () => {
  const refPublish = '2026-07-27T21:00:00Z';

  it('is silent when every CDN serves an identical manifest generation', () => {
    const same = mpd({ kid: KID_A, publishTime: refPublish, bands: BANDS });
    const findings = compareManifestsAcrossCdns([
      endpoint('fastly', 'reference', same, master(BANDS)),
      endpoint('akamai', 'candidate', same, master(BANDS)),
    ]);
    expect(findings).toEqual([]);
  });

  it('flags a KID drift on the candidate CDN as a critical XCDN-001', () => {
    const findings = compareManifestsAcrossCdns([
      endpoint('fastly', 'reference', mpd({ kid: KID_A, publishTime: refPublish, bands: BANDS }), null),
      endpoint('akamai', 'candidate', mpd({ kid: KID_B, publishTime: refPublish, bands: BANDS }), null),
    ]);
    const f = findings.find((x) => x.ruleId === 'SA-XCDN-001');
    expect(f).toBeTruthy();
    expect(f!.classification).toBe('DRM_KID_MISMATCH');
    expect(f!.severity).toBe('critical');
    expect(f!.endpointId).toBe('akamai');
    expect(f!.evidence.manifestKid).toBe(KID_B);
    expect(f!.evidence.referenceKid).toBe(KID_A);
  });

  it('flags a differing DASH bitrate ladder as XCDN-002', () => {
    const findings = compareManifestsAcrossCdns([
      endpoint('fastly', 'reference', mpd({ kid: KID_A, publishTime: refPublish, bands: BANDS }), null),
      endpoint('akamai', 'candidate', mpd({ kid: KID_A, publishTime: refPublish, bands: [800000, 2400000] }), null),
    ]);
    const f = findings.find((x) => x.ruleId === 'SA-XCDN-002' && x.protocol === 'dash');
    expect(f).toBeTruthy();
    expect(f!.classification).toBe('REPRESENTATION_DRIFT');
    expect(f!.endpointId).toBe('akamai');
  });

  it('flags a lagging live publishTime as XCDN-003', () => {
    const findings = compareManifestsAcrossCdns([
      endpoint('fastly', 'reference', mpd({ kid: KID_A, publishTime: refPublish, bands: BANDS }), null),
      endpoint('akamai', 'candidate', mpd({ kid: KID_A, publishTime: '2026-07-27T20:58:00Z', bands: BANDS }), null),
    ]);
    const f = findings.find((x) => x.ruleId === 'SA-XCDN-003');
    expect(f).toBeTruthy();
    expect(f!.classification).toBe('MANIFEST_STALE');
    expect(f!.evidence.skewSeconds).toBe(120); // reference is 120s ahead
  });

  it('does not flag a publishTime skew within tolerance', () => {
    const findings = compareManifestsAcrossCdns([
      endpoint('fastly', 'reference', mpd({ kid: KID_A, publishTime: refPublish, bands: BANDS }), null),
      endpoint('akamai', 'candidate', mpd({ kid: KID_A, publishTime: '2026-07-27T20:59:50Z', bands: BANDS }), null),
    ]);
    expect(findings.find((x) => x.ruleId === 'SA-XCDN-003')).toBeUndefined();
  });

  it('flags a differing HLS variant ladder as XCDN-002', () => {
    const findings = compareManifestsAcrossCdns([
      endpoint('fastly', 'reference', null, master(BANDS)),
      endpoint('akamai', 'candidate', null, master([800000, 6000000])),
    ]);
    const f = findings.find((x) => x.ruleId === 'SA-XCDN-002' && x.protocol === 'hls');
    expect(f).toBeTruthy();
    expect(f!.endpointId).toBe('akamai');
  });
});

import { describe, it, expect } from 'vitest';
import { compareDashHls } from '../../src/stream-assurance/index.js';

const WIDEVINE = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const KID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const KID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('DASH ↔ HLS cross-protocol comparison', () => {
  it('consistent DASH and HLS yield no findings', () => {
    expect(compareDashHls({
      dashDefaultKid: KID_A, hlsInitKid: KID_A,
      dashSystems: [WIDEVINE], hlsKeyFormats: [`urn:uuid:${WIDEVINE}`],
      dashCodecs: ['avc1.640028', 'mp4a.40.2'], hlsCodecs: ['avc1.64001f', 'mp4a.40.2'],
      dashLive: true, hlsLive: true,
    })).toHaveLength(0);
  });

  it('KID mismatch across protocols ⇒ SA-XDRM-001', () => {
    const f = compareDashHls({ dashDefaultKid: KID_A, hlsInitKid: KID_B });
    expect(f[0].ruleId).toBe('SA-XDRM-001');
    expect(f[0].classification).toBe('DASH_HLS_MISMATCH');
    expect(f[0].severity).toBe('critical');
  });

  it('different DRM systems (Widevine vs FairPlay) ⇒ SA-XDRM-001', () => {
    const f = compareDashHls({ dashSystems: [WIDEVINE], hlsKeyFormats: ['com.apple.streamingkeydelivery'] });
    expect(f.some((x) => x.ruleId === 'SA-XDRM-001')).toBe(true);
  });

  it('different codecs ⇒ SA-XDRM-002', () => {
    const f = compareDashHls({ dashCodecs: ['hev1.1.6.L93.B0'], hlsCodecs: ['avc1.640028'] });
    expect(f[0].ruleId).toBe('SA-XDRM-002');
  });

  it('live vs VOD mode mismatch ⇒ SA-XDRM-002', () => {
    const f = compareDashHls({ dashLive: true, hlsLive: false });
    expect(f[0].ruleId).toBe('SA-XDRM-002');
    expect(f[0].explanation).toMatch(/live.*VOD/);
  });
});

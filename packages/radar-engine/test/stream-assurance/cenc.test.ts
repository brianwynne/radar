import { describe, it, expect } from 'vitest';
import { parseBoxes, analyseInitSegment } from '../../src/stream-assurance/index.js';
import { buildInitSegment, WIDEVINE } from './fixtures.js';

describe('analyseInitSegment (CENC/DRM signalling — no keys)', () => {
  it('extracts full KID, scheme, IV size, PSSH and track metadata from an encrypted init', () => {
    const kid = '11111111-2222-3333-4444-555555555555';
    const seg = buildInitSegment({ kid, scheme: 'cbcs', ivSize: 8, handler: 'soun', codec: 'mp4a' });
    const info = analyseInitSegment(seg, parseBoxes(seg).boxes);

    expect(info.cenc.isProtected).toBe(true);
    expect(info.cenc.scheme).toBe('cbcs');
    expect(info.cenc.defaultKid).toBe(kid); // full canonical UUID, not a fixed byte offset
    expect(info.cenc.perSampleIvSize).toBe(8);

    expect(info.pssh).toHaveLength(1);
    expect(info.pssh[0].systemId).toBe(WIDEVINE);
    expect(info.pssh[0].systemName).toBe('Widevine');
    expect(info.pssh[0].kids).toContain(kid);
    expect(info.pssh[0].dataSize).toBe(0);

    expect(info.majorBrand).toBe('iso6');
    expect(info.compatibleBrands).toEqual(expect.arrayContaining(['dash', 'cmfc']));

    const track = info.tracks[0];
    expect(track.trackId).toBe(1);
    expect(track.handler).toBe('soun');
    expect(track.timescale).toBe(48000);
    expect(track.codec).toBe('mp4a'); // original format from frma (encrypted box was 'enca')
  });

  it('reports a clear init as unprotected with no KID and no PSSH', () => {
    const seg = buildInitSegment({ protected: false });
    const info = analyseInitSegment(seg, parseBoxes(seg).boxes);
    expect(info.cenc.isProtected).toBe(false);
    expect(info.cenc.defaultKid).toBeNull();
    expect(info.cenc.scheme).toBeNull();
    expect(info.pssh).toHaveLength(0);
  });

  it('never exposes key material — only identifiers and lengths are surfaced', () => {
    const seg = buildInitSegment();
    const info = analyseInitSegment(seg, parseBoxes(seg).boxes);
    const json = JSON.stringify(info);
    expect(json).not.toMatch(/key|secret|licen[cs]e/i);
    // pssh is summarised by dataSize only; no `data` field is present.
    expect(info.pssh[0]).not.toHaveProperty('data');
  });
});

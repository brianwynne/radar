import { describe, it, expect } from 'vitest';
import { analyseMediaFragment, compareFragmentTimelines, parseBoxes, type EndpointFragment } from '../../src/stream-assurance/index.js';
import { buildInitSegment, buildMediaFragment } from './fixtures.js';

const analyse = (data: Uint8Array) => analyseMediaFragment(data, parseBoxes(data).boxes);

describe('analyseMediaFragment (moof timeline)', () => {
  it('extracts sequence, decode time, sample count and total duration', () => {
    const frag = buildMediaFragment({ sequenceNumber: 42, baseMediaDecodeTime: 90000, trackId: 1, sampleDurations: [1024, 1024, 1024] });
    const info = analyse(frag);
    expect(info.sequenceNumber).toBe(42);
    expect(info.baseMediaDecodeTime).toBe(90000);
    expect(info.trackId).toBe(1);
    expect(info.sampleCount).toBe(3);
    expect(info.totalDuration).toBe(3072);
  });

  it('reads a 64-bit tfdt (version 1)', () => {
    const info = analyse(buildMediaFragment({ baseMediaDecodeTime: 5_000_000_000, version1: true }));
    expect(info.baseMediaDecodeTime).toBe(5_000_000_000);
  });

  it('returns nulls with a warning when there is no moof (e.g. an init segment)', () => {
    const info = analyse(buildInitSegment());
    expect(info.baseMediaDecodeTime).toBeNull();
    expect(info.sequenceNumber).toBeNull();
    expect(info.warnings.join(' ')).toMatch(/no moof/);
  });
});

const ep = (id: string, role: 'reference' | 'candidate', frag: Uint8Array | null): EndpointFragment => ({
  endpointId: id, provider: id === 'fastly' ? 'fastly' : 'akamai', role,
  fragment: frag ? analyse(frag) : null,
});

describe('compareFragmentTimelines (cross-CDN)', () => {
  it('is silent when every CDN serves the same fragment generation', () => {
    const frag = buildMediaFragment({ sequenceNumber: 10, baseMediaDecodeTime: 90000 });
    expect(compareFragmentTimelines([ep('fastly', 'reference', frag), ep('akamai', 'candidate', frag)])).toEqual([]);
  });

  it('flags a decode-time drift on the candidate CDN as SA-FRAG-001', () => {
    const findings = compareFragmentTimelines([
      ep('fastly', 'reference', buildMediaFragment({ sequenceNumber: 10, baseMediaDecodeTime: 90000 })),
      ep('akamai', 'candidate', buildMediaFragment({ sequenceNumber: 9, baseMediaDecodeTime: 84000 })),
    ]);
    const f = findings.find((x) => x.ruleId === 'SA-FRAG-001');
    expect(f).toBeTruthy();
    expect(f!.classification).toBe('FRAGMENT_TIMELINE_DRIFT');
    expect(f!.endpointId).toBe('akamai');
    expect(f!.evidence.baseMediaDecodeTime).toBe(84000);
    expect(f!.evidence.referenceBaseMediaDecodeTime).toBe(90000);
  });
});

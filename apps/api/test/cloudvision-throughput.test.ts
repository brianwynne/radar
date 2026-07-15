// CloudVision throughput maths: reported-vs-derived, counter rollover, device reboot,
// duplicate/zero/backwards intervals, spike rejection, utilisation + headroom. Every
// untrustworthy case must yield UNAVAILABLE, never an invented number.
import { describe, it, expect } from 'vitest';
import { deriveBandwidthBps, headroomBps, resolveBandwidth, utilisationPercent } from '../src/cloudvision/throughput.js';

const t0 = new Date('2026-07-15T12:00:00Z');
const at = (secs: number) => new Date(t0.getTime() + secs * 1000);

describe('deriveBandwidthBps', () => {
  it('derives a rate from two counters (octets → bits / seconds)', () => {
    // +125,000,000 octets over 10s = 1e9 bits/s.
    const r = deriveBandwidthBps({ octets: 0n, at: at(0) }, { octets: 125_000_000n, at: at(10) }, { speedBps: 10e9 });
    expect(r.source).toBe('DERIVED');
    expect(r.bps).toBeCloseTo(1e8 * 8 / 8, 0); // 125e6*8/10 = 1e8 bps
    expect(r.bps).toBe((125_000_000 * 8) / 10);
  });

  it('assumes rollover when the counter wraps (curr < prev, no reboot)', () => {
    const r = deriveBandwidthBps({ octets: 900n, at: at(0) }, { octets: 100n, at: at(10) }, { counterMaxOctets: 1000n, speedBps: 10e9 });
    expect(r.source).toBe('DERIVED');
    expect(r.bps).toBe(((1000 - 900 + 100) * 8) / 10); // 200 octets wrapped
    expect(r.warnings.join()).toMatch(/rollover/i);
  });

  it('does NOT derive across a device reboot (counters reset)', () => {
    const r = deriveBandwidthBps({ octets: 900n, at: at(0) }, { octets: 100n, at: at(10) }, { rebooted: true });
    expect(r.source).toBe('UNAVAILABLE');
    expect(r.warnings.join()).toMatch(/reboot/i);
  });

  it('rejects a duplicate timestamp (zero interval)', () => {
    const r = deriveBandwidthBps({ octets: 0n, at: at(0) }, { octets: 1_000n, at: at(0) }, {});
    expect(r.source).toBe('UNAVAILABLE');
    expect(r.warnings.join()).toMatch(/interval/i);
  });

  it('rejects a backwards timestamp', () => {
    const r = deriveBandwidthBps({ octets: 0n, at: at(10) }, { octets: 1_000n, at: at(0) }, {});
    expect(r.source).toBe('UNAVAILABLE');
  });

  it('is UNAVAILABLE with no previous sample', () => {
    expect(deriveBandwidthBps(null, { octets: 1n, at: at(1) }, {}).source).toBe('UNAVAILABLE');
  });

  it('discards an unrealistic spike above interface speed', () => {
    // 1e9 octets over 1s = 8e9 bps, but the interface is 1e9 bps → discard.
    const r = deriveBandwidthBps({ octets: 0n, at: at(0) }, { octets: 1_000_000_000n, at: at(1) }, { speedBps: 1e9 });
    expect(r.source).toBe('UNAVAILABLE');
    expect(r.warnings.join()).toMatch(/ceiling/i);
  });
});

describe('resolveBandwidth', () => {
  it('prefers a directly-reported rate over derivation', () => {
    const r = resolveBandwidth(5e9, { bps: 1e9, source: 'DERIVED', warnings: [] });
    expect(r).toMatchObject({ bps: 5e9, source: 'REPORTED' });
  });
  it('falls back to derived when no reported rate', () => {
    const r = resolveBandwidth(null, { bps: 1e9, source: 'DERIVED', warnings: ['w'] });
    expect(r).toMatchObject({ bps: 1e9, source: 'DERIVED' });
  });
  it('ignores a negative reported rate', () => {
    expect(resolveBandwidth(-1, { bps: null, source: 'UNAVAILABLE', warnings: [] }).source).toBe('UNAVAILABLE');
  });
});

describe('utilisationPercent / headroomBps', () => {
  it('computes utilisation', () => {
    expect(utilisationPercent(4e9, 10e9)).toBe(40);
  });
  it('is null for missing rate or non-positive speed', () => {
    expect(utilisationPercent(null, 10e9)).toBeNull();
    expect(utilisationPercent(4e9, 0)).toBeNull();
  });
  it('computes headroom, clamped at zero', () => {
    expect(headroomBps(10e9, 4e9)).toBe(6e9);
    expect(headroomBps(10e9, 12e9)).toBe(0);
    expect(headroomBps(null, 4e9)).toBeNull();
  });
});

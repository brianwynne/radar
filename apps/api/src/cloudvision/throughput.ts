// Pure throughput + utilisation maths. Bandwidth is PREFERRED from what CloudVision reports
// directly; where that is unavailable it is DERIVED from interface octet counters across two
// samples. Counter derivation is defensive: it handles counter rollover, device reboot,
// duplicate/backwards timestamps, missing samples, zero intervals and unrealistic spikes —
// and, in every one of those cases, yields UNAVAILABLE rather than an invented number.
import type { BandwidthSource } from './types.js';

/** Standard 64-bit interface octet counter modulus (2^64). BigInt keeps wrap maths exact. */
export const DEFAULT_COUNTER_MAX_OCTETS = 1n << 64n;
/** Tolerance above interface speed before a derived rate is judged unrealistic (10%). */
export const SPIKE_TOLERANCE = 1.1;
/** Absolute derived-rate ceiling when the interface speed is unknown (2 Tbps). */
export const ABSOLUTE_CEILING_BPS = 2e12;

export interface CounterSample {
  /** Cumulative octets (bytes) — inbound or outbound. */
  octets: bigint;
  at: Date;
}

export interface DeriveOptions {
  /** Interface speed (bps) for the spike sanity check, if known. */
  speedBps?: number | null;
  /** Counter modulus for rollover (default 2^64). */
  counterMaxOctets?: bigint;
  /** Device rebooted between samples → counters reset, so a drop is NOT a rollover. */
  rebooted?: boolean;
}

export interface BandwidthResult {
  bps: number | null;
  source: BandwidthSource;
  warnings: string[];
}

const unavailable = (warning: string): BandwidthResult => ({ bps: null, source: 'UNAVAILABLE', warnings: [warning] });

/** Derive a bit-rate from two cumulative octet counters. Returns UNAVAILABLE (never a
 *  guess) for any condition where the rate cannot be trusted. */
export function deriveBandwidthBps(prev: CounterSample | null, curr: CounterSample | null, opts: DeriveOptions = {}): BandwidthResult {
  if (prev === null || curr === null) return unavailable('Insufficient counter history to derive bandwidth.');

  const deltaMs = curr.at.getTime() - prev.at.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    // Duplicate or backwards timestamp, or a zero interval — cannot divide by it.
    return unavailable('Non-positive sample interval; bandwidth not derived.');
  }

  // A reboot resets counters; a drop across a reboot is a reset, not a rollover.
  if (opts.rebooted) return unavailable('Device reboot detected; counters reset, bandwidth not derived for this interval.');

  const counterMax = opts.counterMaxOctets ?? DEFAULT_COUNTER_MAX_OCTETS;
  const warnings: string[] = [];
  let deltaOctets: bigint;
  if (curr.octets >= prev.octets) {
    deltaOctets = curr.octets - prev.octets;
  } else {
    // curr < prev with no reboot ⇒ assume a counter rollover.
    if (prev.octets > counterMax) return unavailable('Counter exceeds its modulus; bandwidth not derived.');
    deltaOctets = counterMax - prev.octets + curr.octets;
    warnings.push('Counter rollover assumed; bandwidth derived across the wrap.');
  }

  const bps = (Number(deltaOctets) * 8) / (deltaMs / 1000);
  if (!Number.isFinite(bps) || bps < 0) return unavailable('Derived bandwidth is not a finite value.');

  // Spike sanity: a derived rate above interface speed (+tolerance), or above an absolute
  // ceiling when speed is unknown, is unrealistic — discard rather than present it.
  const speed = opts.speedBps ?? null;
  const ceiling = speed !== null && Number.isFinite(speed) && speed > 0 ? speed * SPIKE_TOLERANCE : ABSOLUTE_CEILING_BPS;
  if (bps > ceiling) {
    return unavailable('Derived bandwidth exceeds a realistic ceiling; discarded as a counter artefact.');
  }

  return { bps, source: 'DERIVED', warnings };
}

/** Resolve the bandwidth to report: prefer a directly-reported value; otherwise fall back to
 *  the derived one. Reported values are trusted as-is (still non-negative + finite). */
export function resolveBandwidth(reportedBps: number | null, derived: BandwidthResult): BandwidthResult {
  if (reportedBps !== null && Number.isFinite(reportedBps) && reportedBps >= 0) {
    return { bps: reportedBps, source: 'REPORTED', warnings: [] };
  }
  return derived;
}

/** Utilisation percent of a rate against interface speed. Null for a missing rate or a
 *  non-positive/invalid speed (never divides by zero, never invents a value). */
export function utilisationPercent(bps: number | null, speedBps: number | null): number | null {
  if (bps === null || !Number.isFinite(bps) || bps < 0) return null;
  if (speedBps === null || !Number.isFinite(speedBps) || speedBps <= 0) return null;
  return (bps / speedBps) * 100;
}

/** Headroom = speed − current throughput. Null when either is unavailable. Clamped at 0 so a
 *  momentary over-line reading never shows negative capacity. */
export function headroomBps(speedBps: number | null, bps: number | null): number | null {
  if (bps === null || !Number.isFinite(bps) || bps < 0) return null;
  if (speedBps === null || !Number.isFinite(speedBps) || speedBps <= 0) return null;
  return Math.max(0, speedBps - bps);
}

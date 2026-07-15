// Utilisation colour hysteresis: amber at 60% of capacity, red at 80%, releasing only a few
// points below (55% / 75%) so the colour doesn't bounce as bandwidth jitters around a threshold.
import { describe, it, expect } from 'vitest';
import { nextUtilLevel, type UtilLevel } from '../pages/NetworkTelemetry';

describe('nextUtilLevel', () => {
  it('rises through the thresholds from a clear state', () => {
    expect(nextUtilLevel(40, 'ok')).toBe('ok');
    expect(nextUtilLevel(60, 'ok')).toBe('warn'); // amber at exactly 60%
    expect(nextUtilLevel(79, 'ok')).toBe('warn');
    expect(nextUtilLevel(80, 'ok')).toBe('crit'); // red at exactly 80%
    expect(nextUtilLevel(95, 'ok')).toBe('crit');
  });

  it('holds amber in the release band instead of dropping straight back to clear', () => {
    expect(nextUtilLevel(56, 'warn')).toBe('warn'); // above the 55% release floor → stays amber
    expect(nextUtilLevel(55, 'warn')).toBe('warn');
    expect(nextUtilLevel(54, 'warn')).toBe('ok'); // only clears once it drops below 55%
    expect(nextUtilLevel(80, 'warn')).toBe('crit'); // escalates to red at 80%
  });

  it('holds red in its release band and steps down one level at a time', () => {
    expect(nextUtilLevel(76, 'crit')).toBe('crit'); // above the 75% release floor → stays red
    expect(nextUtilLevel(75, 'crit')).toBe('crit');
    expect(nextUtilLevel(74, 'crit')).toBe('warn'); // red → amber, not straight to clear
    expect(nextUtilLevel(50, 'crit')).toBe('ok'); // a big drop clears fully
  });

  it('does not bounce while oscillating around a threshold', () => {
    let lvl: UtilLevel = 'ok';
    for (const u of [61, 59, 61, 58, 62]) lvl = nextUtilLevel(u, lvl); // dips below 60 but stays ≥55
    expect(lvl).toBe('warn'); // never flickered back to ok
  });

  it('treats missing utilisation as clear and is a fixed point when re-applied', () => {
    expect(nextUtilLevel(null, 'crit')).toBe('ok');
    // Re-applying with the same value never advances the level (safe under re-render).
    const lvl = nextUtilLevel(82, 'ok'); // → crit
    expect(nextUtilLevel(82, lvl)).toBe(lvl);
  });
});

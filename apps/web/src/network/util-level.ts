// Utilisation colour level with hysteresis, shared by the Network Telemetry page and the OTT Delivery
// tab so both alert identically. A link turns amber at 60% of capacity and red at 80%, but only clears
// back once it drops a few points below (55% / 75%) — so the colour does not bounce as the 10-second
// bandwidth jitters around a threshold. `prev` is the level from the previous poll; the transition is
// single-step and a fixed point when re-applied to the same value (re-rendering never advances it).
export type UtilLevel = 'ok' | 'warn' | 'crit';

const RISE_WARN = 60;
const FALL_WARN = 55;
const RISE_CRIT = 80;
const FALL_CRIT = 75;

export function nextUtilLevel(util: number | null, prev: UtilLevel): UtilLevel {
  if (util === null || !Number.isFinite(util)) return 'ok'; // no measurable load → no colour
  if (prev === 'crit') return util < FALL_CRIT ? (util < FALL_WARN ? 'ok' : 'warn') : 'crit';
  if (prev === 'warn') return util >= RISE_CRIT ? 'crit' : util < FALL_WARN ? 'ok' : 'warn';
  return util >= RISE_CRIT ? 'crit' : util >= RISE_WARN ? 'warn' : 'ok';
}

export const utilClass = (lvl: UtilLevel): string | undefined => (lvl === 'crit' ? 'util-crit' : lvl === 'warn' ? 'util-warn' : undefined);

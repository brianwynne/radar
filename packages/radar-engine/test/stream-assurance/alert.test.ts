import { describe, it, expect } from 'vitest';
import { nextAlertState, INITIAL_LIFECYCLE, isOpen, type AlertLifecycle } from '../../src/stream-assurance/index.js';

const run = (lifecycles: boolean[], policy = {}): AlertLifecycle[] => {
  const out: AlertLifecycle[] = [];
  let cur = INITIAL_LIFECYCLE;
  for (const present of lifecycles) { cur = nextAlertState(cur, present, policy); out.push(cur); }
  return out;
};

describe('alert state machine', () => {
  it('promotes observed → pending → active over consecutive present runs (default 3)', () => {
    const states = run([true, true, true]).map((l) => l.state);
    expect(states).toEqual(['observed', 'pending', 'active']);
  });

  it('does not go active on a single transient occurrence', () => {
    const [first] = run([true]);
    expect(first.state).toBe('observed'); // not active
    expect(isOpen(first.state)).toBe(true);
  });

  it('auto-resolves after the configured consecutive-absent count', () => {
    const seq = run([true, true, true, false, false]); // active, then two absent
    expect(seq[2].state).toBe('active');
    expect(seq[3].state).toBe('active'); // 1 absent < resolveAfter(2)
    expect(seq[4].state).toBe('resolved');
  });

  it('reopens a fresh incident when it recurs after resolving', () => {
    let cur = INITIAL_LIFECYCLE;
    for (const p of [true, true, true, false, false]) cur = nextAlertState(cur, p); // → resolved
    expect(cur.state).toBe('resolved');
    cur = nextAlertState(cur, true); // recurs
    expect(cur.state).toBe('observed');
    expect(cur.consecutivePresent).toBe(1);
  });

  it('keeps an acknowledged alert acknowledged while present, then resolves when cleared', () => {
    let cur: AlertLifecycle = { state: 'acknowledged', consecutivePresent: 5, consecutiveAbsent: 0 };
    cur = nextAlertState(cur, true);
    expect(cur.state).toBe('acknowledged');
    cur = nextAlertState(cur, false);
    cur = nextAlertState(cur, false);
    expect(cur.state).toBe('resolved');
  });

  it('honours a rule-specific lower activation threshold', () => {
    const states = run([true, true], { activateAfter: 1 }).map((l) => l.state);
    expect(states[0]).toBe('active'); // activates immediately
  });
});

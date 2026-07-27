import { describe, it, expect, vi } from 'vitest';
import { StreamAssuranceScheduler } from '../../src/stream-assurance/scheduler.js';
import type { StreamAssuranceRepository } from '@radar/data';
import type { StreamAssuranceService } from '../../src/stream-assurance/service.js';

function timers() {
  const intervals: { fn: () => void; ms: number }[] = [];
  const timeouts: { fn: () => void; ms: number }[] = [];
  return {
    intervals, timeouts,
    setIntervalImpl: (fn: () => void, ms: number) => { const h = { fn, ms }; intervals.push(h); return h as unknown as ReturnType<typeof setInterval>; },
    clearIntervalImpl: (t: unknown) => { const i = intervals.indexOf(t as { fn: () => void; ms: number }); if (i >= 0) intervals.splice(i, 1); },
    setTimeoutImpl: (fn: () => void, ms: number) => { const h = { fn, ms }; timeouts.push(h); return h as unknown as ReturnType<typeof setTimeout>; },
    clearTimeoutImpl: (t: unknown) => { const i = timeouts.indexOf(t as { fn: () => void; ms: number }); if (i >= 0) timeouts.splice(i, 1); },
  };
}

const repoWith = (profiles: { id: string; enabled: boolean }[]): StreamAssuranceRepository =>
  ({ listProfiles: async () => profiles } as unknown as StreamAssuranceRepository);

const flush = () => new Promise((r) => setImmediate(r));

describe('StreamAssuranceScheduler', () => {
  it('normal tick runs only ENABLED profiles', async () => {
    const t = timers();
    const run = vi.fn(async () => ({}));
    const sched = new StreamAssuranceScheduler(repoWith([{ id: 'a', enabled: true }, { id: 'b', enabled: false }]), { run } as unknown as StreamAssuranceService, t);
    sched.start();
    expect(t.intervals).toHaveLength(1);
    t.intervals[0].fn(); await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('a', 'normal');
    sched.stop();
    expect(t.intervals).toHaveLength(0);
  });

  it('event mode runs faster, is skipped by the normal tick, and auto-expires', async () => {
    const t = timers();
    const run = vi.fn(async () => ({}));
    const sched = new StreamAssuranceScheduler(repoWith([{ id: 'a', enabled: true }]), { run } as unknown as StreamAssuranceService, t);
    sched.start();

    sched.startEventMode('a', 30 * 60_000);
    expect(sched.eventModeProfiles()).toEqual(['a']);
    // Event interval fires an 'event' run.
    const eventInterval = t.intervals.at(-1)!;
    eventInterval.fn(); await flush();
    expect(run).toHaveBeenCalledWith('a', 'event');

    // The normal tick skips a profile already covered by event mode.
    run.mockClear();
    t.intervals[0].fn(); await flush();
    expect(run).not.toHaveBeenCalled();

    // Expiry stops event mode.
    t.timeouts.at(-1)!.fn();
    expect(sched.eventModeProfiles()).toEqual([]);
    sched.stop();
  });
});

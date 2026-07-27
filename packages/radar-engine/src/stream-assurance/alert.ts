// Alert lifecycle state machine for Stream Assurance findings. A finding seen across successive runs
// is promoted through observed → pending → active with a configurable consecutive-present threshold
// (so a single transient failure does not raise a critical alert), can be acknowledged by an
// operator, and auto-resolves after a configurable consecutive-absent count. Pure and deterministic.

export type AlertState = 'observed' | 'pending' | 'active' | 'acknowledged' | 'resolved';

export interface AlertLifecycle {
  state: AlertState;
  /** Consecutive runs the finding was present. */
  consecutivePresent: number;
  /** Consecutive runs the finding was absent. */
  consecutiveAbsent: number;
}

export interface AlertPolicy {
  /** Consecutive present runs required to reach `active` (default 3). Rules may lower this. */
  activateAfter?: number;
  /** Consecutive absent runs required to auto-resolve (default 2). */
  resolveAfter?: number;
}

export const INITIAL_LIFECYCLE: AlertLifecycle = { state: 'resolved', consecutivePresent: 0, consecutiveAbsent: 0 };

/** Compute the next lifecycle given whether the finding is present in the current run. An operator
 *  acknowledgement is sticky (state `acknowledged`) while the finding remains present. */
export function nextAlertState(cur: AlertLifecycle, present: boolean, policy: AlertPolicy = {}): AlertLifecycle {
  const activateAfter = Math.max(1, policy.activateAfter ?? 3);
  const resolveAfter = Math.max(1, policy.resolveAfter ?? 2);

  if (present) {
    const reopening = cur.state === 'resolved';
    const consecutivePresent = reopening ? 1 : cur.consecutivePresent + 1;
    let state: AlertState;
    if (cur.state === 'acknowledged') state = 'acknowledged'; // ack sticks while still present
    else if (consecutivePresent >= activateAfter) state = 'active';
    else if (consecutivePresent >= 2) state = 'pending';
    else state = 'observed';
    return { state, consecutivePresent, consecutiveAbsent: 0 };
  }

  // Absent this run.
  const consecutiveAbsent = cur.state === 'resolved' ? cur.consecutiveAbsent : cur.consecutiveAbsent + 1;
  if (cur.state !== 'resolved' && consecutiveAbsent >= resolveAfter) {
    return { state: 'resolved', consecutivePresent: 0, consecutiveAbsent };
  }
  return { state: cur.state, consecutivePresent: 0, consecutiveAbsent };
}

/** States that warrant operator attention (drive counts/badges). */
export const OPEN_STATES: AlertState[] = ['observed', 'pending', 'active', 'acknowledged'];
export const isOpen = (s: AlertState): boolean => OPEN_STATES.includes(s);

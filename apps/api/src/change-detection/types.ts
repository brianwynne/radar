// Change-detection abstractions. The event SOURCE is deliberately behind an interface so
// the current NS1 Activity-API poller can later be swapped for native NS1 webhooks (or any
// other source) WITHOUT changing the detection/processing logic that consumes it.
import type { ActivityItem } from '../ns1/activity.js';

/** A processed-position marker. Prefer the activity id; fall back to a timestamp. */
export interface Checkpoint {
  id?: string;
  occurredAt?: string;
}

export interface ActivityBatch {
  /** Activity entries, newest first. */
  entries: ActivityItem[];
}

/** Replaceable source of activity/change events (poller today; webhooks tomorrow). */
export interface ChangeEventSource {
  /** A stable name for logging/status (e.g. "ns1-activity-poll"). */
  readonly name: string;
  /** Return the current activity view. The service owns checkpointing and de-duplication. */
  poll(correlationId?: string): Promise<ActivityBatch>;
}

export interface WatchedRecord {
  zone: string;
  domain: string;
  type: string;
}

export interface IspScenario {
  id: string;
  name: string;
  asn: number;
  ecsPrefix: string;
}

/** Emitted when a relevant NS1 change is detected, a snapshot captured and steering
 *  re-evaluated. Downstream consumers (none yet; future UI/webhook fan-out) subscribe. */
export interface SteeringChangedEvent {
  at: string;
  record: WatchedRecord;
  snapshotId: string;
  activity: { id?: string; action?: string; actor?: string };
  evaluations: {
    isp: string;
    asn: number;
    identitySource: string;
    eligibleAnswerIds: string[];
    complete: boolean;
  }[];
}

export type SteeringChangedListener = (event: SteeringChangedEvent) => void;

export interface ChangeDetectionStatus {
  enabled: boolean;
  running: boolean;
  source: string;
  intervalMs: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  checkpoint: Checkpoint | null;
  consecutiveFailures: number;
  eventsPublished: number;
  /** Safe, generic last-error code (never a stack trace or upstream detail). */
  lastError: string | null;
}

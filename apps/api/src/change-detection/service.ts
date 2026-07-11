// Change Detection service. Periodically polls a ChangeEventSource (NS1 Activity API
// today), detects NS1 configuration changes relevant to RADAR, and — only then — fetches
// the affected record(s), captures a snapshot, re-evaluates the configured Live Steering
// ISP scenarios, persists the latest per-ISP steering state, records a steering-change
// event when (and only when) the meaningful steering fingerprint changes, publishes an
// internal SteeringChanged event and records an audit event.
//
// Safety: fails closed (errors are caught, never thrown out of the loop), backs off on
// repeated failures, and preserves the last successful checkpoint so a failed cycle is
// retried rather than skipped. It never evaluates unless a relevant change actually
// occurred. When a PollerLock is configured only the lock-holding replica polls; on
// shutdown the lock is released so another replica can take over. No NS1 writes, no
// queues, no sockets.
import { evaluate, type Scenario } from '@radar/engine';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { RadarMode } from '../ns1/config.js';
import type { ActivityItem } from '../ns1/activity.js';
import { Ns1Error } from '../ns1/errors.js';
import { normaliseRecord } from '../ns1/normalise.js';
import { captureRecordSnapshot } from '../ns1/snapshot-capture.js';
import type { Database } from '../database/repositories.js';
import type { SteeringStore } from '../database/steering-store.js';
import type { PollerLock } from '../database/poller-lock.js';
import { DEFAULT_WATCHED_RECORDS, ISP_SCENARIOS } from './isps.js';
import { buildSteeringState, classifyReason } from './steering-state.js';
import type {
  ChangeDetectionStatus,
  ChangeEventSource,
  Checkpoint,
  IspScenario,
  SteeringChangedEvent,
  SteeringChangedListener,
  WatchedRecord,
} from './types.js';

const RELEVANT_TYPES = new Set(['record', 'zone', 'answer', 'filter']);
const CHANGE_ACTIONS = new Set(['update', 'create', 'delete', 'edit', 'modify', 'add', 'remove']);

/** A change affecting RADAR-relevant DNS config: a create/update/delete on a zone, record,
 *  answer or filter. Reads/views are ignored. */
export function isRelevantActivity(e: ActivityItem): boolean {
  return RELEVANT_TYPES.has((e.resourceType ?? '').toLowerCase()) && CHANGE_ACTIONS.has((e.action ?? '').toLowerCase());
}

function matchesRecord(e: ActivityItem, rec: WatchedRecord): boolean {
  const key = e.resourceKey ?? '';
  if ((e.resourceType ?? '').toLowerCase() === 'zone') return key === rec.zone;
  return key === `${rec.domain}/${rec.type}` || key === `${rec.zone}/${rec.domain}/${rec.type}` || key.includes(rec.domain);
}

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface ChangeDetectionDeps {
  source: ChangeEventSource;
  client: Ns1ReadClient;
  database: Database;
  mode: RadarMode;
  /** Persistent checkpoint/state/event store. When omitted the service runs in-memory only. */
  steeringStore?: SteeringStore;
  /** Multi-replica single-poller lock. When omitted every replica polls (single-instance). */
  lock?: PollerLock;
  watchedRecords?: WatchedRecord[];
  ispScenarios?: IspScenario[];
  intervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  logger?: Logger;
}

export interface RunResult {
  processed: number;
  baseline?: boolean;
  /** This replica does not hold the poller lock; it polled nothing this cycle. */
  passive?: boolean;
  /** Number of steering-change events persisted this cycle. */
  events?: number;
  error?: string;
}

const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class ChangeDetectionService {
  private readonly source: ChangeEventSource;
  private readonly client: Ns1ReadClient;
  private readonly database: Database;
  private readonly mode: RadarMode;
  private readonly steeringStore?: SteeringStore;
  private readonly lock?: PollerLock;
  private readonly watchedRecords: WatchedRecord[];
  private readonly ispScenarios: IspScenario[];
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  private checkpoint: Checkpoint | null = null;
  private initialised = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private consecutiveFailures = 0;
  private eventsPublished = 0;
  private lastError: string | null = null;
  private readonly listeners = new Set<SteeringChangedListener>();

  constructor(deps: ChangeDetectionDeps) {
    this.source = deps.source;
    this.client = deps.client;
    this.database = deps.database;
    this.mode = deps.mode;
    this.steeringStore = deps.steeringStore;
    this.lock = deps.lock;
    this.watchedRecords = deps.watchedRecords ?? DEFAULT_WATCHED_RECORDS;
    this.ispScenarios = deps.ispScenarios ?? ISP_SCENARIOS;
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.maxBackoffMs = deps.maxBackoffMs ?? 5 * 60_000;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? noopLogger;
  }

  subscribe(listener: SteeringChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private newestCheckpoint(entries: ActivityItem[]): Checkpoint | null {
    const top = entries[0];
    return top ? { id: top.id, occurredAt: top.occurredAt } : null;
  }

  /** Entries strictly newer than the current checkpoint (deduplicated). */
  private selectNew(entries: ActivityItem[]): ActivityItem[] {
    const cp = this.checkpoint;
    if (!cp) return [];
    const out: ActivityItem[] = [];
    for (const e of entries) {
      if (cp.id && e.id && e.id === cp.id) break;
      if (cp.occurredAt && e.occurredAt && e.occurredAt <= cp.occurredAt) break;
      out.push(e);
    }
    return out;
  }

  private affectedRecords(relevant: ActivityItem[]): WatchedRecord[] {
    return this.watchedRecords.filter((rec) => relevant.some((e) => matchesRecord(e, rec)));
  }

  private emit(event: SteeringChangedEvent): void {
    this.eventsPublished += 1;
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A downstream listener must never break detection.
      }
    }
  }

  /** Load the persisted checkpoint once, so a restart resumes from the last processed
   *  position instead of re-baselining (and re-processing history). */
  private async ensureInitialised(): Promise<void> {
    if (this.initialised) return;
    if (this.steeringStore) {
      const rec = await this.steeringStore.checkpoints.get(this.source.name);
      if (rec && (rec.checkpointId || rec.checkpointOccurredAt)) {
        this.checkpoint = { id: rec.checkpointId, occurredAt: rec.checkpointOccurredAt?.toISOString() };
      }
    }
    this.initialised = true;
  }

  /** Persist the current checkpoint. Called only after successful processing, so a failed
   *  cycle never advances the durable checkpoint. */
  private async persistCheckpoint(): Promise<void> {
    if (!this.steeringStore || !this.checkpoint) return;
    await this.steeringStore.checkpoints.upsert(
      this.source.name,
      this.checkpoint.id,
      this.checkpoint.occurredAt ? new Date(this.checkpoint.occurredAt) : undefined,
    );
  }

  private async processRecord(rec: WatchedRecord, relevant: ActivityItem[]): Promise<number> {
    const raw = await this.client.getRecord(rec.zone, rec.domain, rec.type);
    const record = normaliseRecord(raw);
    const snapshot = await captureRecordSnapshot(this.database, rec, raw, this.mode, {
      createdBySubject: 'system:change-detection',
      label: 'auto-captured on NS1 activity',
    });
    const resourceKey = `${rec.zone}/${rec.domain}/${rec.type}`;
    const recordChecksum = snapshot.structuralChecksum ?? snapshot.rawChecksum;
    const trigger = relevant.find((e) => matchesRecord(e, rec)) ?? relevant[0];
    const activity = { id: trigger?.id, action: trigger?.action, actor: trigger?.actor, resourceKey: trigger?.resourceKey };

    const evaluations: SteeringChangedEvent['evaluations'] = [];
    let eventsCreated = 0;
    for (const isp of this.ispScenarios) {
      const scenario: Scenario = { qname: rec.domain, qtype: rec.type, resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: isp.ecsPrefix, country: 'IE', asn: isp.asn };
      const ev = evaluate(record, scenario);
      evaluations.push({ isp: isp.name, asn: isp.asn, identitySource: ev.identity.source, eligibleAnswerIds: ev.eligibleAnswerIds, complete: ev.complete });

      if (this.steeringStore) {
        eventsCreated += await this.persistSteering(isp, resourceKey, ev, recordChecksum, activity);
      }
    }

    const event: SteeringChangedEvent = {
      at: this.iso(this.now()),
      record: rec,
      snapshotId: snapshot.id,
      activity: { id: trigger?.id, action: trigger?.action, actor: trigger?.actor },
      evaluations,
    };
    this.emit(event);

    await this.database.audit.record({
      actorSubject: 'system:change-detection',
      actorRoles: [],
      action: 'steering.change.detected',
      resourceType: 'record',
      resourceKey,
      outcome: 'success',
      details: { snapshotId: snapshot.id, ispCount: evaluations.length, steeringEvents: eventsCreated, activityAction: trigger?.action, source: this.source.name },
    });
    return eventsCreated;
  }

  /** Persist the latest steering state for one ISP scenario and, only when the meaningful
   *  fingerprint changed against the previous persisted state, record a steering-change
   *  event with an attributed reason. Returns the number of events created (0 or 1). */
  private async persistSteering(
    isp: IspScenario,
    resourceKey: string,
    ev: ReturnType<typeof evaluate>,
    recordChecksum: string,
    activity: Record<string, unknown>,
  ): Promise<number> {
    const store = this.steeringStore;
    if (!store) return 0;
    const next = buildSteeringState(ev, isp, resourceKey, recordChecksum, new Date(this.now()));
    const prev = await store.states.get(isp.id, resourceKey);
    // Always persist the latest state (even when unchanged, so evaluatedAt advances).
    await store.states.upsert(next);
    // Emit an event ONLY when a previous baseline exists and the fingerprint changed. On
    // first observation there is nothing to compare, so no causality is invented.
    if (!prev || prev.fingerprint === next.fingerprint) return 0;
    await store.events.create({
      occurredAt: new Date(this.now()),
      ispId: isp.id,
      ispName: isp.name,
      asn: isp.asn,
      resourceKey,
      reason: classifyReason(prev, next),
      previousFingerprint: prev.fingerprint,
      currentFingerprint: next.fingerprint,
      previousState: prev,
      currentState: next,
      previousChecksum: prev.structuralChecksum,
      currentChecksum: next.structuralChecksum,
      activity,
    });
    return 1;
  }

  /** One poll cycle. Never throws. */
  async runOnce(): Promise<RunResult> {
    this.lastRunAt = this.iso(this.now());

    // Multi-replica gate: only the lock holder polls. A passive replica keeps trying so it
    // can take over when the active replica releases the lock on shutdown.
    if (this.lock && !this.lock.held) {
      let got: boolean;
      try {
        got = await this.lock.acquire();
      } catch (err) {
        this.onFailure(err);
        return { processed: 0, error: this.lastError ?? 'ERROR' };
      }
      if (!got) return { processed: 0, passive: true };
    }

    try {
      await this.ensureInitialised();
      const { entries } = await this.source.poll();

      // First run: adopt the newest position as a baseline and process nothing.
      if (this.checkpoint === null) {
        this.checkpoint = this.newestCheckpoint(entries);
        await this.persistCheckpoint();
        this.onSuccess();
        return { processed: 0, baseline: true, events: 0 };
      }

      const relevant = this.selectNew(entries).filter(isRelevantActivity);
      let processed = 0;
      let events = 0;
      if (relevant.length > 0) {
        for (const rec of this.affectedRecords(relevant)) {
          events += await this.processRecord(rec, relevant);
          processed += 1;
        }
      }
      // Advance only after successful processing (a failure preserves the checkpoint).
      this.checkpoint = this.newestCheckpoint(entries) ?? this.checkpoint;
      await this.persistCheckpoint();
      this.onSuccess();
      return { processed, events };
    } catch (err) {
      this.onFailure(err);
      return { processed: 0, error: this.lastError ?? 'ERROR' };
    }
  }

  private onSuccess(): void {
    this.lastSuccessAt = this.iso(this.now());
    this.consecutiveFailures = 0;
    this.lastError = null;
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    this.lastError = err instanceof Ns1Error ? err.code : 'INTERNAL_ERROR';
    this.logger.warn({ source: this.source.name, code: this.lastError, failures: this.consecutiveFailures }, 'change-detection poll failed');
  }

  private nextDelay(): number {
    if (this.consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs);
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    const schedule = (delay: number): void => {
      this.timer = setTimeout(() => {
        void this.runOnce().finally(() => {
          if (this.running) schedule(this.nextDelay());
        });
      }, delay);
    };
    schedule(0);
  }

  /** Stop polling and release the poller lock so another replica can take over. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.lock) await this.lock.release();
  }

  status(): ChangeDetectionStatus {
    return {
      enabled: true,
      running: this.running,
      source: this.source.name,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      checkpoint: this.checkpoint,
      consecutiveFailures: this.consecutiveFailures,
      eventsPublished: this.eventsPublished,
      lastError: this.lastError,
    };
  }
}

// Persists RIS Live BGP events into the bounded history store that backs the BGP Intelligence
// timeline, by periodically draining the in-memory RIS buffer (upsert-on-id, so a cluster's later
// observations update the same row). Also records RIS connection-state transitions so a collector
// gap is visible as a gap in observation, not silently shown as "all quiet". Read-only external
// observation — only prefix/ASN/path metadata is stored, never secrets. All DB work is
// fire-and-forget: a persistence failure is logged, never affecting RIPE polling.
import type { NewRisEvent, RisEventRepository } from '@radar/data';
import type { RisEvent } from './ris-live.js';

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_DRAIN_INTERVAL_MS = 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000; // hourly

interface Logger {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface RisEventRecorderDeps {
  /** Current in-memory RIS event buffer (e.g. () => ripeService.events()). */
  getEvents: () => RisEvent[];
  /** Current RIS Live connection state (e.g. () => ripeService.sourceHealth().risLiveState). */
  getState: () => string;
  retentionDays?: number;
  drainIntervalMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (t: ReturnType<typeof setInterval>) => void;
  logger?: Logger;
}

const toNew = (e: RisEvent): NewRisEvent => ({
  id: e.id,
  kind: e.kind,
  prefix: e.prefix,
  originAsn: e.origin,
  peerAsn: e.peerAsn,
  path: e.path,
  observationCount: e.observationCount,
  firstAt: new Date(e.firstAt),
  lastAt: new Date(e.lastAt),
});

export class RisEventRecorder {
  private readonly retentionMs: number;
  private readonly drainIntervalMs: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (t: ReturnType<typeof setInterval>) => void;
  private readonly logger?: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastState: string | null = null;
  private lastPruneAt = 0;

  constructor(private readonly repo: RisEventRepository, private readonly deps: RisEventRecorderDeps) {
    this.retentionMs = (deps.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86_400_000;
    this.drainIntervalMs = deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.pruneIntervalMs = deps.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = deps.clearIntervalImpl ?? ((t) => clearInterval(t));
    this.logger = deps.logger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => this.drain(), this.drainIntervalMs);
  }

  stop(): void {
    if (this.timer) { this.clearIntervalImpl(this.timer); this.timer = null; }
  }

  /** One drain cycle: persist the current buffer, record any connection-state change, maybe prune.
   *  Fire-and-forget; returns the promise for tests. */
  drain(): void {
    const events = this.deps.getEvents();
    const state = this.deps.getState();

    if (state !== this.lastState) {
      const prev = this.lastState;
      this.lastState = state;
      void this.repo
        .recordConnectionState({ at: new Date(this.now()), state, detail: prev ? `from ${prev}` : 'initial' })
        .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'ris-events: connection-state persist failed'));
    }

    if (events.length > 0) {
      void this.repo
        .upsertBatch(events.map(toNew))
        .then(() => this.maybePrune())
        .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'ris-events: persist failed'));
    } else {
      this.maybePrune();
    }
  }

  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs) return;
    this.lastPruneAt = now;
    void this.repo
      .prune(new Date(now - this.retentionMs))
      .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'ris-events: prune failed'));
  }
}

// Periodically samples total live delivery (Réalta eyeball + commercial CDNs) into the bounded
// history store that backs the Dashboard pie's 1-hour average, and prunes past the retention horizon.
// Read-only-derived: only aggregate bit-rates are stored. All DB work is fire-and-forget.
import type { DeliverySampleRepository } from '@radar/data';
import { computeDeliverySplit } from './delivery.js';
import type { NetworkStateSnapshot } from '../cloudvision/types.js';
import type { FastlySnapshot } from '../fastly/types.js';
import type { AkamaiSnapshot } from '../akamai/types.js';

const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_PRUNE_INTERVAL_MS = 30 * 60_000;
const DEFAULT_RETENTION_HOURS = 25; // > 1h window with slack

interface Logger { warn: (obj: Record<string, unknown>, msg?: string) => void }

export interface DeliveryRecorderDeps {
  getNetwork: () => NetworkStateSnapshot | null;
  getFastly: () => FastlySnapshot | null;
  getAkamai: () => AkamaiSnapshot | null;
  sampleIntervalMs?: number;
  pruneIntervalMs?: number;
  retentionHours?: number;
  now?: () => number;
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (t: ReturnType<typeof setInterval>) => void;
  logger?: Logger;
}

export class DeliveryRecorder {
  private readonly retentionMs: number;
  private readonly sampleIntervalMs: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (t: ReturnType<typeof setInterval>) => void;
  private readonly logger?: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPruneAt = 0;

  constructor(private readonly repo: DeliverySampleRepository, private readonly deps: DeliveryRecorderDeps) {
    this.retentionMs = (deps.retentionHours ?? DEFAULT_RETENTION_HOURS) * 3_600_000;
    this.sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.pruneIntervalMs = deps.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = deps.clearIntervalImpl ?? ((t) => clearInterval(t));
    this.logger = deps.logger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => this.sample(), this.sampleIntervalMs);
  }

  stop(): void {
    if (this.timer) { this.clearIntervalImpl(this.timer); this.timer = null; }
  }

  /** One sample cycle: compute the current split and persist the totals. Skips writing when there
   *  is no delivery observed at all (avoids seeding the average with cold-start zeros). */
  sample(): void {
    const split = computeDeliverySplit(this.deps.getNetwork(), this.deps.getFastly(), this.deps.getAkamai());
    if (split.totalBps <= 0) { this.maybePrune(); return; }
    void this.repo
      .insert({ at: new Date(this.now()), realtaBps: split.realtaBps, commercialBps: split.commercialBps, totalBps: split.totalBps })
      .then(() => this.maybePrune())
      .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'delivery: persist failed'));
  }

  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs) return;
    this.lastPruneAt = now;
    void this.repo
      .prune(new Date(now - this.retentionMs))
      .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'delivery: prune failed'));
  }
}

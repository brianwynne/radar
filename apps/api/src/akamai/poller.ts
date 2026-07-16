// Akamai S3 poller: periodically lists new DataStream 2 log objects in the bucket, downloads them,
// parses the edge-log records, and feeds them to the aggregator. Read-only. DS2 object keys are
// time-ordered, so `start-after` the greatest key already processed fetches only newer objects; the
// aggregator's window prune makes reprocessing/backlog harmless. A poll failure keeps the last data
// and is surfaced via status (never fabricated).
import { parseDataStreamUpload } from './datastream.js';
import type { AkamaiAggregator } from './aggregator.js';
import type { S3ReadClient } from './s3-client.js';

const MAX_OBJECTS_PER_POLL = 300;

export interface AkamaiS3PollerDeps {
  s3: S3ReadClient | null;
  aggregator: AkamaiAggregator;
  prefix: string;
  intervalMs: number;
  enabled: boolean;
  now?: () => number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface AkamaiS3PollerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  objectsProcessed: number;
  recordsIngested: number;
}

export class AkamaiS3Poller {
  private s3: S3ReadClient | null;
  private aggregator: AkamaiAggregator;
  private prefix: string;
  private intervalMs: number;
  private enabled: boolean;
  private readonly now: () => number;
  private readonly logger?: AkamaiS3PollerDeps['logger'];

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey: string | null = null;
  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private objectsProcessed = 0;
  private recordsIngested = 0;

  constructor(deps: AkamaiS3PollerDeps) {
    this.s3 = deps.s3;
    this.aggregator = deps.aggregator;
    this.prefix = deps.prefix;
    this.intervalMs = deps.intervalMs;
    this.enabled = deps.enabled;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
  }

  async runOnce(): Promise<{ ok: boolean; objects: number; records: number; error?: string }> {
    this.lastPollAt = this.now();
    if (!this.s3) return { ok: false, objects: 0, records: 0, error: 'no s3 client' };
    try {
      let token: string | undefined;
      let processed = 0;
      let records = 0;
      let maxKey = this.lastKey;
      do {
        const page = await this.s3.listObjects(this.prefix, token ? { continuationToken: token } : { startAfter: this.lastKey ?? undefined });
        for (const obj of page.objects) {
          if (processed >= MAX_OBJECTS_PER_POLL) break;
          const buf = await this.s3.getObject(obj.key);
          records += this.aggregator.ingest(parseDataStreamUpload(buf));
          processed += 1;
          if (maxKey === null || obj.key > maxKey) maxKey = obj.key;
        }
        token = processed >= MAX_OBJECTS_PER_POLL ? undefined : (page.nextToken ?? undefined);
      } while (token);

      this.lastKey = maxKey;
      this.objectsProcessed += processed;
      this.recordsIngested += records;
      this.lastSuccessAt = this.now();
      this.consecutiveFailures = 0;
      this.lastError = null;
      return { ok: true, objects: processed, records };
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastError = err instanceof Error ? err.message : 'poll failed';
      this.logger?.warn({ consecutiveFailures: this.consecutiveFailures }, 'akamai-s3: poll failed');
      return { ok: false, objects: 0, records: 0, error: this.lastError };
    }
  }

  start(): void {
    if (!this.enabled || !this.s3 || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  status(): AkamaiS3PollerStatus {
    return {
      enabled: this.enabled,
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt !== null ? new Date(this.lastPollAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt !== null ? new Date(this.lastSuccessAt).toISOString() : null,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      objectsProcessed: this.objectsProcessed,
      recordsIngested: this.recordsIngested,
    };
  }
}

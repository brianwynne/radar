// Akamai S3 poller: periodically finds recently-delivered DataStream 2 log objects, downloads them,
// parses the edge-log records, and feeds them to the aggregator. Read-only.
//
// Objects are ingested by RECENCY (each object's S3 LastModified), NOT by key order. DS2 names objects
// `ak-{id}-{timestamp}-…` where the leading id does not track time, so the keys are not globally
// time-ordered — a `start-after the greatest key` scheme silently skips newer objects whose id sorts
// lower, which stalls live ingestion. Instead each poll scans the bucket, ingests objects modified
// within the fresh window that haven't been ingested yet (deduped via a bounded seen-map), and skips
// everything older — so the backlog and any pre-switch structured logs are ignored for free. A poll
// failure keeps the last data and is surfaced via status (never fabricated).
import { parseDataStreamUpload } from './datastream.js';
import type { AkamaiAggregator } from './aggregator.js';
import type { S3ReadClient } from './s3-client.js';

const MAX_OBJECTS_PER_POLL = 300; // cap downloads per cycle; any overflow is picked up next poll
const MAX_LIST_PAGES = 1000; // runaway backstop for the listing scan (~1M objects at 1000/page)
const DEFAULT_FRESH_WINDOW_MS = 15 * 60_000; // ingest objects modified in the last 15 min (covers the aggregator window + DS2 delivery lag)

export interface AkamaiS3PollerDeps {
  s3: S3ReadClient | null;
  aggregator: AkamaiAggregator;
  prefix: string;
  intervalMs: number;
  enabled: boolean;
  /** How recently an object must have been modified to be ingested. Default 15 min. */
  freshWindowMs?: number;
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
  private readonly freshWindowMs: number;
  private readonly now: () => number;
  private readonly logger?: AkamaiS3PollerDeps['logger'];

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Keys already ingested → their LastModified ms. Bounded: entries are dropped once they age out of
   *  the fresh window, so this can't grow without limit and never re-fetches a still-fresh object. */
  private seen = new Map<string, number>();
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
    this.freshWindowMs = deps.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
  }

  async runOnce(): Promise<{ ok: boolean; objects: number; records: number; error?: string }> {
    this.lastPollAt = this.now();
    if (!this.s3) return { ok: false, objects: 0, records: 0, error: 'no s3 client' };
    try {
      const freshFromMs = this.now() - this.freshWindowMs;
      // Forget objects that have aged out of the window so the seen-map stays bounded.
      for (const [key, modMs] of this.seen) if (modMs < freshFromMs) this.seen.delete(key);

      let processed = 0;
      let records = 0;
      let pages = 0;
      let token: string | undefined;
      let capped = false;
      do {
        const page = await this.s3.listObjects(this.prefix, token ? { continuationToken: token } : {});
        pages += 1;
        for (const obj of page.objects) {
          const modMs = Date.parse(obj.lastModified);
          // Skip objects that are stale (outside the window) or already ingested. Recency, not key order.
          if (!Number.isFinite(modMs) || modMs < freshFromMs || this.seen.has(obj.key)) continue;
          if (processed >= MAX_OBJECTS_PER_POLL) { capped = true; break; } // rest picked up next poll
          const buf = await this.s3.getObject(obj.key);
          records += this.aggregator.ingest(parseDataStreamUpload(buf));
          this.seen.set(obj.key, modMs);
          processed += 1;
        }
        token = capped ? undefined : (page.nextToken ?? undefined);
      } while (token && pages < MAX_LIST_PAGES);
      if (pages >= MAX_LIST_PAGES && token) this.logger?.warn({ pages }, 'akamai-s3: listing scan hit the page cap — set a lifecycle rule or a tighter prefix');

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

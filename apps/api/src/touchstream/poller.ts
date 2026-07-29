// Self-rescheduling Touchstream poller. Read-only runtime: fetches the monitored-stream status plus
// the location index, builds a canonical snapshot, and keeps the last good one.
//
// Location groups change rarely and cost a whole extra request, so they are cached and refreshed on a
// slower cycle; a refresh failure reuses the cached index rather than losing probe geography.
// Mirrors the CloudVision poller: no overlap, backoff on failure, last-good preserved, bounded state.
import { buildSnapshot } from './adapter.js';
import { TouchstreamError, type TouchstreamClient } from './client.js';
import type { TouchstreamSnapshot } from './types.js';
import type { TsLocationGroup } from './wire.js';

interface Logger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface TouchstreamConnectorStatus {
  enabled: boolean;
  running: boolean;
  source: 'mock' | 'live' | 'disabled';
  intervalMs: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  snapshotAgeSeconds: number | null;
  monitorCount: number;
  /** Age of the newest Touchstream sample in the snapshot, as reported by Touchstream. */
  oldestSampleAgeSeconds: number | null;
  stale: boolean;
}

export interface TouchstreamPollerDeps {
  client: TouchstreamClient;
  source: 'mock' | 'live';
  enabled: boolean;
  intervalMs: number;
  ownedPrefixes: string[];
  maxSampleAgeSeconds: number;
  /** Optional: connectors are constructed before the Fastify instance exists, so the server passes
   *  nothing here. `status().lastError` remains the operator-visible signal either way. */
  logger?: Logger;
  now?: () => number;
  /** How often to re-read the location groups (they are near-static config). */
  locationRefreshMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_LOCATION_REFRESH_MS = 15 * 60_000;

export class TouchstreamPoller {
  private readonly logger?: Logger;
  private readonly now: () => number;
  private readonly locationRefreshMs: number;
  private readonly maxBackoffMs: number;

  private client: TouchstreamClient;
  private source: 'mock' | 'live';
  private enabled: boolean;
  private intervalMs: number;
  private ownedPrefixes: string[];
  private maxSampleAgeSeconds: number;

  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private latest: TouchstreamSnapshot | null = null;
  private locationGroups: (TsLocationGroup | null)[] = [];
  private locationsFetchedAt = 0;
  private lastPollAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastDurationMs: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;

  constructor(deps: TouchstreamPollerDeps) {
    this.client = deps.client;
    this.source = deps.source;
    this.enabled = deps.enabled;
    this.intervalMs = deps.intervalMs;
    this.ownedPrefixes = deps.ownedPrefixes;
    this.maxSampleAgeSeconds = deps.maxSampleAgeSeconds;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
    this.locationRefreshMs = deps.locationRefreshMs ?? DEFAULT_LOCATION_REFRESH_MS;
    this.maxBackoffMs = deps.maxBackoffMs ?? 5 * 60_000;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (this.timer) this.schedule(this.nextDelayMs());
      });
    }, delayMs);
    // Never hold the process open for a poll.
    this.timer.unref?.();
  }

  private nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs);
  }

  /** One poll. Never throws — a failure is recorded and the last good snapshot is kept. */
  async runOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const started = this.now();
    this.lastPollAt = new Date(started).toISOString();
    try {
      if (this.locationGroups.length === 0 || started - this.locationsFetchedAt > this.locationRefreshMs) {
        try {
          this.locationGroups = await this.client.fetchLocationGroups();
          this.locationsFetchedAt = started;
        } catch (err) {
          // Probe geography is a nicety; losing it must not lose the whole snapshot.
          this.logger?.warn({ err: describe(err) }, 'touchstream: location refresh failed, reusing cached index');
        }
      }
      const streams = await this.client.fetchStreams();
      const capturedAt = new Date(this.now()).toISOString();
      this.latest = buildSnapshot({
        streams,
        locationGroups: this.locationGroups,
        capturedAt,
        source: this.source,
        ownedPrefixes: this.ownedPrefixes,
        now: this.now(),
      });
      this.lastSuccessAt = capturedAt;
      this.consecutiveFailures = 0;
      this.lastError = null;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastError = describe(err);
      this.logger?.warn(
        { source: this.source, consecutiveFailures: this.consecutiveFailures, code: err instanceof TouchstreamError ? err.code : 'error' },
        'touchstream: poll failed',
      );
    } finally {
      this.lastDurationMs = this.now() - started;
      this.polling = false;
    }
  }

  snapshot(): TouchstreamSnapshot | null {
    return this.latest;
  }

  status(): TouchstreamConnectorStatus {
    const snapshotAge = this.latest ? Math.max(0, (this.now() - Date.parse(this.latest.capturedAt)) / 1000) : null;
    const sampleAge = this.latest?.summary.oldestSampleAgeSeconds ?? null;
    return {
      enabled: this.enabled,
      running: this.timer !== null,
      source: this.enabled ? this.source : 'disabled',
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastDurationMs: this.lastDurationMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      snapshotAgeSeconds: snapshotAge === null ? null : Math.round(snapshotAge),
      monitorCount: this.latest?.summary.monitorCount ?? 0,
      oldestSampleAgeSeconds: sampleAge,
      stale: sampleAge !== null && sampleAge > this.maxSampleAgeSeconds,
    };
  }

  /** Swap client/mode at runtime (used when the connector is reconfigured). */
  reconfigure(deps: { client: TouchstreamClient; source: 'mock' | 'live'; enabled: boolean; intervalMs: number; ownedPrefixes?: string[] }): void {
    this.stop();
    this.client = deps.client;
    this.source = deps.source;
    this.enabled = deps.enabled;
    this.intervalMs = deps.intervalMs;
    if (deps.ownedPrefixes) this.ownedPrefixes = deps.ownedPrefixes;
    this.latest = null;
    this.locationGroups = [];
    this.locationsFetchedAt = 0;
    this.consecutiveFailures = 0;
    this.lastError = null;
    if (deps.enabled) this.start();
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

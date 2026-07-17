// CloudVision polling runtime. Periodically pulls a canonical NetworkStateSnapshot from the
// client, keeps the latest plus a bounded in-memory history (ring buffer — no unbounded
// growth, no persistence), and exposes connector status. Safety: never throws out of the
// loop, prevents overlapping polls, backs off on repeated failures, and preserves the last
// good snapshot so a failed cycle degrades rather than blanks. Observability is structured
// logs (poll duration + failure counts as fields) — matching the house style; no NS1 or
// device writes ever occur here.
import { CloudVisionError } from './errors.js';
import type { CloudVisionClient, CloudVisionSource, FreshnessLevel, NetworkStateSnapshot } from './types.js';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}
const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A compact point for the time-series charts — never the full snapshot (bounded memory). */
export interface CloudVisionHistoryPoint {
  at: string;
  totalEdgeThroughputBps: number | null;
  totalPeeringThroughputBps: number | null;
  totalTransitThroughputBps: number | null;
  operationalCapacityBps: number | null;
  operationalHeadroomBps: number | null;
  unhealthyLinks: number;
  unhealthyBgpPeers: number;
  freshness: FreshnessLevel;
}

export interface CloudVisionConnectorStatus {
  enabled: boolean;
  running: boolean;
  source: CloudVisionSource;
  intervalMs: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  snapshotAgeSeconds: number | null;
  historyLength: number;
  deviceCount: number;
  interfaceCount: number;
  unknownInterfaceCount: number;
  /** How many edge-device IDs the connector is filtered to. 0 = no filter → ALL discovered
   *  devices are shown (routers AND switches); set edge device IDs to limit to edge routers. */
  edgeDeviceIdCount: number;
}

export interface CloudVisionPollerDeps {
  client: CloudVisionClient;
  /** For status display (mock/cloudvision/disabled). */
  source: CloudVisionSource;
  intervalMs: number;
  maxBackoffMs?: number;
  /** Ring-buffer size (default 720 ≈ 2h at a 10s interval). */
  historyLimit?: number;
  /** Whether the connector is enabled at all (a disabled connector still answers status). */
  enabled?: boolean;
  /** Number of edge-device IDs the connector is filtered to (0 = show all discovered devices). */
  edgeDeviceIdCount?: number;
  now?: () => number;
  logger?: Logger;
}

export class CloudVisionPoller {
  // Mutable so the connector manager can reconfigure a running poller in place (the routes
  // hold a stable reference); everything else is fixed for the poller's lifetime.
  private client: CloudVisionClient;
  private source: CloudVisionSource;
  private intervalMs: number;
  private enabled: boolean;
  private readonly maxBackoffMs: number;
  private readonly historyLimit: number;
  private edgeDeviceIdCount: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  private latest: NetworkStateSnapshot | null = null;
  private history: CloudVisionHistoryPoint[] = [];
  private running = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastDurationMs: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;

  constructor(deps: CloudVisionPollerDeps) {
    this.client = deps.client;
    this.source = deps.source;
    this.intervalMs = deps.intervalMs;
    this.maxBackoffMs = deps.maxBackoffMs ?? 5 * 60_000;
    this.historyLimit = deps.historyLimit ?? 720;
    this.enabled = deps.enabled ?? true;
    this.edgeDeviceIdCount = deps.edgeDeviceIdCount ?? 0;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? noopLogger;
  }

  getLatest(): NetworkStateSnapshot | null {
    return this.latest;
  }

  getHistory(limit?: number): CloudVisionHistoryPoint[] {
    return limit && limit > 0 ? this.history.slice(-limit) : [...this.history];
  }

  /** One poll cycle. Never throws; the last good snapshot is preserved on failure. */
  async runOnce(correlationId?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.inFlight) return { ok: false, error: 'IN_FLIGHT' }; // no overlapping polls
    this.inFlight = true;
    const start = this.now();
    this.lastPollAt = new Date(start).toISOString();
    try {
      const snapshot = await this.client.getSnapshot(correlationId);
      this.latest = snapshot;
      this.pushHistory(snapshot);
      this.lastDurationMs = this.now() - start;
      this.lastSuccessAt = new Date(this.now()).toISOString();
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.logger.info(
        { source: this.source, durationMs: this.lastDurationMs, devices: snapshot.summary.deviceCount, interfaces: snapshot.summary.interfaceCount, unknownInterfaces: snapshot.summary.unknownInterfaceCount, freshness: snapshot.freshness.level, completeness: snapshot.completeness.level },
        'cloudvision poll complete',
      );
      return { ok: true };
    } catch (err) {
      this.lastDurationMs = this.now() - start;
      this.consecutiveFailures += 1;
      this.lastError = err instanceof CloudVisionError ? err.code : 'INTERNAL_ERROR';
      this.logger.warn({ source: this.source, code: this.lastError, failures: this.consecutiveFailures, durationMs: this.lastDurationMs }, 'cloudvision poll failed');
      return { ok: false, error: this.lastError };
    } finally {
      this.inFlight = false;
    }
  }

  private pushHistory(snapshot: NetworkStateSnapshot): void {
    this.history.push({
      at: snapshot.capturedAt,
      totalEdgeThroughputBps: snapshot.summary.totalEdgeThroughputBps,
      totalPeeringThroughputBps: snapshot.summary.totalPeeringThroughputBps,
      totalTransitThroughputBps: snapshot.summary.totalTransitThroughputBps,
      operationalCapacityBps: snapshot.summary.operationalCapacityBps,
      operationalHeadroomBps: snapshot.summary.operationalHeadroomBps,
      unhealthyLinks: snapshot.summary.unhealthyLinks,
      unhealthyBgpPeers: snapshot.summary.unhealthyBgpPeers,
      freshness: snapshot.freshness.level,
    });
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
  }

  private nextDelay(): number {
    if (this.consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs);
  }

  start(): void {
    if (this.timer || !this.enabled) return;
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

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Swap the client/source/interval/enabled at runtime (Engineer changed the connection).
   *  Stale data from the previous connection is discarded — a different connection must not
   *  inherit the old snapshot/history. Restarts polling when enabled. */
  reconfigure(deps: { client: CloudVisionClient; source: CloudVisionSource; intervalMs: number; enabled: boolean; edgeDeviceIdCount?: number }): void {
    this.stop();
    this.client = deps.client;
    this.source = deps.source;
    this.intervalMs = deps.intervalMs;
    this.enabled = deps.enabled;
    this.edgeDeviceIdCount = deps.edgeDeviceIdCount ?? 0;
    this.latest = null;
    this.history = [];
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastPollAt = null;
    this.lastSuccessAt = null;
    this.lastDurationMs = null;
    // A runtime reconfigure (re)starts polling when enabled; a disabled connector stays stopped.
    if (deps.enabled) this.start();
  }

  status(): CloudVisionConnectorStatus {
    const snapshotAgeSeconds = this.latest ? Math.max(0, (this.now() - Date.parse(this.latest.capturedAt)) / 1000) : null;
    return {
      enabled: this.enabled,
      running: this.running,
      source: this.source,
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastDurationMs: this.lastDurationMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      snapshotAgeSeconds,
      historyLength: this.history.length,
      deviceCount: this.latest?.summary.deviceCount ?? 0,
      interfaceCount: this.latest?.summary.interfaceCount ?? 0,
      unknownInterfaceCount: this.latest?.summary.unknownInterfaceCount ?? 0,
      edgeDeviceIdCount: this.edgeDeviceIdCount,
    };
  }
}

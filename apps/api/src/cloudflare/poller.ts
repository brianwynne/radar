// Periodic poller: keeps the latest Cloudflare snapshot + connector status in memory. Read-only;
// a poll failure retains the last good snapshot and is surfaced via status (never fabricated).
import type { CloudflareClient, CloudflareFocusedPoolHealth, CloudflareSnapshot } from './types.js';

export interface CloudflareConnectorStatus {
  enabled: boolean;
  running: boolean;
  source: CloudflareSnapshot['source'] | null;
  intervalMs: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  snapshotAgeSeconds: number | null;
  loadBalancerCount: number;
  poolCount: number;
}

export interface CloudflarePollerDeps {
  client: CloudflareClient;
  enabled: boolean;
  intervalMs: number;
  maxSampleAgeSeconds: number;
  now?: () => number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void; info?: (obj: Record<string, unknown>, msg: string) => void };
}

export class CloudflarePoller {
  private client: CloudflareClient;
  private enabled: boolean;
  private intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: CloudflareSnapshot | null = null;
  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastDurationMs: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: CloudflarePollerDeps) {
    this.client = deps.client;
    this.enabled = deps.enabled;
    this.intervalMs = deps.intervalMs;
    this.now = deps.now ?? (() => Date.now());
  }

  latestSnapshot(): CloudflareSnapshot | null {
    return this.latest;
  }

  /** Fast tier: live-refresh just the health+RTT of the given pools (the caller caps the id list). */
  refreshPools(ids: string[], correlationId?: string): Promise<CloudflareFocusedPoolHealth[]> {
    return this.client.getPoolsHealth(ids, correlationId);
  }

  async runOnce(correlationId?: string): Promise<{ ok: boolean; error?: string }> {
    const started = this.now();
    this.lastPollAt = started;
    try {
      const snap = await this.client.getSnapshot(correlationId);
      this.latest = snap;
      this.lastSuccessAt = this.now();
      this.lastDurationMs = this.lastSuccessAt - started;
      this.consecutiveFailures = 0;
      this.lastError = null;
      return { ok: true };
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastDurationMs = this.now() - started;
      this.lastError = err instanceof Error ? err.message : 'poll failed';
      this.deps.logger?.warn({ consecutiveFailures: this.consecutiveFailures }, 'cloudflare: poll failed');
      return { ok: false, error: this.lastError };
    }
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Swap the client (and enabled/interval) at runtime — used by the connector manager when an
   *  Engineer changes the connection. Clears the last snapshot + counters and (re)starts polling
   *  when enabled; a disabled connector stays stopped. */
  reconfigure(deps: { client: CloudflareClient; enabled: boolean; intervalMs: number }): void {
    this.stop();
    this.client = deps.client;
    this.enabled = deps.enabled;
    this.intervalMs = deps.intervalMs;
    this.latest = null;
    this.lastPollAt = null;
    this.lastSuccessAt = null;
    this.lastDurationMs = null;
    this.consecutiveFailures = 0;
    this.lastError = null;
    if (deps.enabled) this.start();
  }

  status(): CloudflareConnectorStatus {
    const ageSeconds = this.lastSuccessAt !== null ? Math.max(0, Math.round((this.now() - this.lastSuccessAt) / 1000)) : null;
    return {
      enabled: this.enabled,
      running: this.timer !== null,
      source: this.latest?.source ?? null,
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt !== null ? new Date(this.lastPollAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt !== null ? new Date(this.lastSuccessAt).toISOString() : null,
      lastDurationMs: this.lastDurationMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      snapshotAgeSeconds: ageSeconds,
      loadBalancerCount: this.latest?.summary.loadBalancerCount ?? 0,
      poolCount: this.latest?.summary.poolCount ?? 0,
    };
  }
}

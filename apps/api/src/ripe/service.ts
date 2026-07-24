// RIPE BGP intelligence service — orchestrates the RIPEstat poller (periodic per-prefix fetch →
// snapshot) and the single managed RIS Live connection. Read-only; no secrets. Self-guards: only
// polls / connects when enabled. Source health combines the last RIPEstat poll with the RIS Live
// connection state — a RIPE failure is "monitoring degraded", never a route withdrawal.
import { buildSnapshot, fetchPrefix } from './adapter.js';
import { createRipestatClient, type RipestatClient } from './client.js';
import type { RipeConfig } from './config.js';
import { RisLiveConnection, type RisEvent, type WsLike, type WsFactory } from './ris-live.js';
import type { RipeSourceHealth, RouteVisibility, RouteVisibilitySnapshot } from './types.js';

interface Logger { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void }

export interface RipeServiceDeps {
  config: RipeConfig;
  client?: RipestatClient;
  wsFactory?: WsFactory;
  now?: () => number;
  logger?: Logger;
}

/** Production WebSocket transport over Node's global WebSocket (undici). Returns null when the
 *  runtime has no WebSocket (RIS Live then stays disabled rather than crashing). */
export function nodeWsFactory(url: string): WsLike {
  const WS = (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket;
  if (!WS) throw new Error('global WebSocket unavailable');
  const ws = new WS(url) as { send(d: string): void; close(): void; addEventListener(t: string, cb: (ev: unknown) => void): void };
  const like: WsLike = { send: (d) => ws.send(d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.addEventListener('open', () => like.onopen?.());
  ws.addEventListener('message', (ev) => { const d = (ev as { data?: unknown }).data; like.onmessage?.(typeof d === 'string' ? d : String(d)); });
  ws.addEventListener('close', () => like.onclose?.());
  ws.addEventListener('error', (ev) => like.onerror?.(ev));
  return like;
}

export class RipeService {
  private readonly cfg: RipeConfig;
  private readonly client: RipestatClient;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly ris: RisLiveConnection | null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private polling = false;
  private lastSnapshot: RouteVisibilitySnapshot | null = null;
  private ripestatLastSuccessAt: string | null = null;
  private ripestatLastError: string | null = null;

  constructor(deps: RipeServiceDeps) {
    this.cfg = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
    this.client = deps.client ?? createRipestatClient({ timeoutMs: this.cfg.timeoutSeconds * 1000, cacheTtlMs: this.cfg.cacheTtlSeconds * 1000, userAgent: this.cfg.userAgent, now: this.now, logger: deps.logger });
    const wsFactory = deps.wsFactory ?? nodeWsFactory;
    this.ris = this.cfg.risLiveEnabled
      ? new RisLiveConnection({ wsFactory, prefixes: () => this.cfg.monitoredPrefixes.map((p) => p.prefix), now: this.now, logger: deps.logger })
      : null;
  }

  start(): void {
    if (!this.stopped || !this.cfg.enabled) return;
    this.stopped = false;
    this.ris?.start();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.ris?.stop();
  }

  snapshot(): RouteVisibilitySnapshot | null { return this.lastSnapshot; }
  events(): RisEvent[] { return this.ris?.events() ?? []; }
  sourceHealth(): RipeSourceHealth { return this.buildSourceHealth(); }

  private async tick(): Promise<void> {
    try { if (this.cfg.enabled) await this.poll(); }
    catch (err) { this.logger?.error({ err: err instanceof Error ? err.message : 'error' }, 'ripe: poll cycle failed'); }
    finally { if (!this.stopped) this.timer = setTimeout(() => void this.tick(), Math.max(60, this.cfg.pollIntervalSeconds) * 1000); }
  }

  /** One poll cycle: fetch every monitored prefix, build the snapshot, update source health. */
  async poll(): Promise<RouteVisibilitySnapshot> {
    if (this.polling) return this.lastSnapshot ?? this.emptySnapshot();
    this.polling = true;
    try {
      const nowMs = this.now();
      const records: RouteVisibility[] = await Promise.all(
        this.cfg.monitoredPrefixes.map((m) => fetchPrefix(this.client, m.prefix, m.expectedOrigin, this.cfg.assess, nowMs)),
      );
      const anyFresh = records.some((r) => r.freshness !== 'unknown');
      if (anyFresh) { this.ripestatLastSuccessAt = new Date(nowMs).toISOString(); this.ripestatLastError = null; }
      else { this.ripestatLastError = records.flatMap((r) => r.warnings)[0] ?? 'RIPEstat unreachable'; }
      const source = this.buildSourceHealth();
      this.lastSnapshot = buildSnapshot(records, source, nowMs);
      this.logger?.info({ overall: this.lastSnapshot.overall, prefixes: records.length, source: source.status }, 'ripe: poll ok');
      return this.lastSnapshot;
    } finally { this.polling = false; }
  }

  private buildSourceHealth(): RipeSourceHealth {
    const risStatus = this.ris?.status();
    const risState = this.cfg.risLiveEnabled ? (risStatus?.state ?? 'disconnected') : 'disabled';
    const reachable = this.ripestatLastError === null && this.ripestatLastSuccessAt !== null;
    const ageSec = this.ripestatLastSuccessAt ? (this.now() - Date.parse(this.ripestatLastSuccessAt)) / 1000 : null;
    let status: RipeSourceHealth['status'];
    if (this.ripestatLastSuccessAt === null && this.ripestatLastError !== null) status = 'unavailable';
    else if (ageSec !== null && ageSec > this.cfg.assess.maxAgeSeconds) status = 'stale';
    else if (risState === 'connected' || (ageSec !== null && ageSec < this.cfg.pollIntervalSeconds * 2)) status = 'live';
    else status = 'cached';
    return {
      ripestatReachable: reachable,
      ripestatLastSuccessAt: this.ripestatLastSuccessAt,
      ripestatLastError: this.ripestatLastError,
      risLiveState: risState,
      risLiveLastMessageAt: risStatus?.lastMessageAt ?? null,
      status,
    };
  }

  private emptySnapshot(): RouteVisibilitySnapshot {
    return { capturedAt: new Date(this.now()).toISOString(), overall: 'unknown', counts: { healthy: 0, degraded: 0, withdrawn: 0, critical: 0, unknown: 0, rpkiInvalid: 0, unexpectedOrigin: 0, total: 0 }, prefixes: [], source: this.buildSourceHealth(), warnings: [] };
  }
}

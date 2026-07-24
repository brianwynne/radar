// RIS Live — ONE managed backend WebSocket to wss://ris-live.ripe.net/v1/ws/ (never per browser
// user). Subscribes only to the configured monitored prefixes, reconnects with exponential
// backoff, tracks connection health, and DEDUPLICATES the many-peer observations into event
// clusters (one event per prefix+kind+path, with an observation count). Bounded in-memory
// timeline. The WebSocket is injected (a minimal interface) so it is fully testable and so the
// production transport (Node global WebSocket / ws) is a thin adapter.

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export type RisEventKind = 'announcement' | 'withdrawal';

export interface RisEvent {
  id: string;
  kind: RisEventKind;
  prefix: string;
  /** The RIS peer ASN that reported it (representative — the cluster spans many peers). */
  peerAsn: number | null;
  /** AS path for an announcement (empty for a withdrawal). */
  path: number[];
  origin: number | null; // origin ASN (last hop)
  firstAt: string; // ISO
  lastAt: string; // ISO
  /** How many peer observations collapsed into this cluster. */
  observationCount: number;
}

export type RisLiveState = 'connected' | 'reconnecting' | 'disconnected' | 'disabled';

export interface RisLiveStatus {
  state: RisLiveState;
  connectedAt: string | null;
  lastMessageAt: string | null;
  reconnectAttempts: number;
  subscribedPrefixes: string[];
  lastError: string | null;
}

export interface RisLiveOptions {
  url?: string;
  wsFactory: WsFactory;
  /** Current monitored prefixes to subscribe to. */
  prefixes: () => string[];
  /** Dedup window (ms): observations of the same prefix+kind+path within this window collapse. */
  dedupWindowMs?: number;
  bufferSize?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (t: ReturnType<typeof setTimeout>) => void;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
  onEvent?: (e: RisEvent) => void;
}

interface RisMessage {
  type?: string;
  data?: {
    timestamp?: number;
    peer?: string;
    peer_asn?: string;
    type?: string;
    path?: number[];
    origin?: string;
    announcements?: { next_hop?: string; prefixes?: string[] }[];
    withdrawals?: string[];
    message?: string;
  };
}

const DEFAULT_URL = 'wss://ris-live.ripe.net/v1/ws/';

export class RisLiveConnection {
  private ws: WsLike | null = null;
  private state: RisLiveState = 'disconnected';
  private connectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private subscribed: string[] = [];
  private readonly buffer: RisEvent[] = [];
  private readonly clusterIndex = new Map<string, RisEvent>();
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearT: (t: ReturnType<typeof setTimeout>) => void;
  private seq = 0;

  constructor(private readonly opts: RisLiveOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutImpl ?? ((t) => clearTimeout(t));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.state = 'disconnected';
    if (this.timer) { this.clearT(this.timer); this.timer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  status(): RisLiveStatus {
    return {
      state: this.state,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      reconnectAttempts: this.reconnectAttempts,
      subscribedPrefixes: [...this.subscribed],
      lastError: this.lastError,
    };
  }

  /** The deduped event timeline, newest first. */
  events(): RisEvent[] {
    return [...this.buffer].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      this.state = this.reconnectAttempts > 0 ? 'reconnecting' : this.state;
      const ws = this.opts.wsFactory(this.opts.url ?? DEFAULT_URL);
      this.ws = ws;
      ws.onopen = () => this.onOpen();
      ws.onmessage = (d) => this.onMessage(d);
      ws.onclose = () => this.onClose('closed');
      ws.onerror = (e) => { this.lastError = e instanceof Error ? e.message : 'ws error'; };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'connect failed';
      this.scheduleReconnect();
    }
  }

  private onOpen(): void {
    this.state = 'connected';
    this.connectedAt = this.now();
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.subscribed = this.opts.prefixes();
    for (const prefix of this.subscribed) {
      this.ws?.send(JSON.stringify({ type: 'ris_subscribe', data: { prefix, moreSpecific: false, type: 'UPDATE' } }));
    }
    this.opts.logger?.info({ prefixes: this.subscribed.length }, 'ris-live: connected + subscribed');
  }

  private onClose(_reason: string): void {
    if (this.stopped) return;
    this.state = 'reconnecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = this.opts.baseBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.timer = this.setT(() => this.connect(), delay);
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = this.now();
    let msg: RisMessage;
    try { msg = JSON.parse(raw) as RisMessage; } catch { return; }
    if (msg.type !== 'ris_message' || !msg.data) return;
    const monitored = new Set(this.opts.prefixes());
    const d = msg.data;
    const peerAsn = d.peer_asn ? Number(d.peer_asn) : null;
    const path = Array.isArray(d.path) ? d.path.filter((n) => Number.isFinite(n)) : [];
    const origin = path.length ? path[path.length - 1] : null;
    const at = typeof d.timestamp === 'number' ? new Date(d.timestamp * 1000).toISOString() : new Date(this.now()).toISOString();

    for (const ann of d.announcements ?? []) {
      for (const prefix of ann.prefixes ?? []) {
        if (monitored.has(prefix)) this.record({ kind: 'announcement', prefix, peerAsn, path, origin, at });
      }
    }
    for (const prefix of d.withdrawals ?? []) {
      if (monitored.has(prefix)) this.record({ kind: 'withdrawal', prefix, peerAsn, path: [], origin: null, at });
    }
  }

  private record(e: { kind: RisEventKind; prefix: string; peerAsn: number | null; path: number[]; origin: number | null; at: string }): void {
    const windowMs = this.opts.dedupWindowMs ?? 60_000;
    const key = `${e.kind}:${e.prefix}:${e.path.join(' ')}`;
    const existing = this.clusterIndex.get(key);
    if (existing && this.now() - Date.parse(existing.lastAt) <= windowMs) {
      existing.observationCount += 1;
      existing.lastAt = e.at;
      return;
    }
    const event: RisEvent = { id: `ris-${this.seq++}`, kind: e.kind, prefix: e.prefix, peerAsn: e.peerAsn, path: e.path, origin: e.origin, firstAt: e.at, lastAt: e.at, observationCount: 1 };
    this.clusterIndex.set(key, event);
    this.buffer.push(event);
    const cap = this.opts.bufferSize ?? 500;
    if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap);
    this.opts.onEvent?.(event);
  }
}

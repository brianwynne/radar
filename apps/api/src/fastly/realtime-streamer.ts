// Fastly real-time STREAMER. Runs one continuous long-poll loop per observed service against the
// real-time client, accumulating a bounded, rolling per-second ring buffer for each. Read-only: it
// only long-polls. A poll failure retains the buffer and is surfaced via status (never fabricated).
// The streamer is the live-tail counterpart of the interval FastlyPoller.
import type {
  FastlyProvenance,
  FastlyRealtimeClient,
  FastlyRealtimeSample,
  FastlyRealtimeSnapshot,
  FastlySource,
} from './types.js';

export interface FastlyRealtimeServiceStatus {
  serviceId: string;
  serviceName: string;
  running: boolean;
  sampleCount: number;
  lastSampleAt: string | null;
  lastPollAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface FastlyRealtimeStatus {
  enabled: boolean;
  running: boolean;
  source: FastlySource;
  windowSeconds: number;
  services: FastlyRealtimeServiceStatus[];
}

export interface FastlyRealtimeStreamerConfig {
  client: FastlyRealtimeClient | null;
  services: { id: string; name: string }[];
  enabled: boolean;
  windowSeconds: number;
  /** 'fastly' when a live client is attached, else 'disabled'. */
  source: FastlySource;
}

export interface FastlyRealtimeStreamerDeps {
  /** Pause between polls that returned no new second (avoids a busy loop); default 1000ms. */
  idleDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

interface ServiceState {
  id: string;
  name: string;
  cursor: number;
  samples: FastlyRealtimeSample[];
  lastPollAt: number | null;
  lastSampleAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  looping: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FastlyRealtimeStreamer {
  private client: FastlyRealtimeClient | null;
  private enabled: boolean;
  private windowSeconds: number;
  private source: FastlySource;
  private states = new Map<string, ServiceState>();

  private readonly idleDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: FastlyRealtimeStreamerDeps['logger'];

  private started = false;
  private stopped = true;
  private abort: AbortController | null = null;

  constructor(config: FastlyRealtimeStreamerConfig, deps: FastlyRealtimeStreamerDeps = {}) {
    this.client = config.client;
    this.enabled = config.enabled;
    this.windowSeconds = config.windowSeconds;
    this.source = config.source;
    this.idleDelayMs = deps.idleDelayMs ?? 1000;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
    this.logger = deps.logger;
    this.rebuildStates(config);
  }

  // ---- Lifecycle ----------------------------------------------------------------------------

  start(): void {
    if (this.started || !this.enabled || !this.client || this.states.size === 0) return;
    this.started = true;
    this.stopped = false;
    this.abort = new AbortController();
    for (const id of this.states.keys()) void this.runLoop(id);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.abort?.abort(); // in-flight long-polls reject with an AbortError the loop swallows
    this.abort = null;
  }

  /** Swap client / services / enabled at runtime — used when an Engineer changes the connection.
   *  Drops all buffers (a new connection is a fresh stream) and (re)starts when enabled. */
  reconfigure(config: FastlyRealtimeStreamerConfig): void {
    this.stop();
    this.client = config.client;
    this.enabled = config.enabled;
    this.windowSeconds = config.windowSeconds;
    this.source = config.source;
    this.rebuildStates(config);
    if (config.enabled) this.start();
  }

  /** A disabled streamer (no client / not enabled) tracks nothing: no per-service rows are shown,
   *  consistent with the route's no-streamer branch and the live-only intent. */
  private rebuildStates(config: FastlyRealtimeStreamerConfig): void {
    const services = config.enabled && config.client ? config.services : [];
    this.states = new Map(
      services
        .filter((s) => s.id.length > 0)
        .map((s) => [s.id, {
          id: s.id, name: s.name || s.id, cursor: 0, samples: [],
          lastPollAt: null, lastSampleAt: null, consecutiveFailures: 0, lastError: null, looping: false,
        }]),
    );
  }

  // ---- Poll loop ----------------------------------------------------------------------------

  private async runLoop(serviceId: string): Promise<void> {
    const state = this.states.get(serviceId);
    if (!state) return;
    state.looping = true;
    while (!this.stopped) {
      const r = await this.pollServiceOnce(serviceId);
      if (this.stopped || r.aborted) break;
      if (!r.ok) await this.sleep(backoffMs(state.consecutiveFailures));
      else if (r.received === 0) await this.sleep(this.idleDelayMs);
      // A successful poll that returned data re-polls immediately: the server long-polls for us.
    }
    state.looping = false;
  }

  /** Run one long-poll for a service and ingest the batch. Exposed for deterministic testing. */
  async pollServiceOnce(serviceId: string): Promise<{ ok: boolean; received: number; aborted?: boolean; error?: string }> {
    const state = this.states.get(serviceId);
    if (!state || !this.client) return { ok: false, received: 0 };
    state.lastPollAt = this.now();
    try {
      const batch = await this.client.pollChannel(state.id, state.cursor, { signal: this.abort?.signal ?? undefined });
      this.ingest(state, batch.samples);
      if (batch.nextTimestamp > 0) state.cursor = batch.nextTimestamp;
      state.consecutiveFailures = 0;
      state.lastError = null;
      return { ok: true, received: batch.samples.length };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { ok: false, received: 0, aborted: true };
      state.consecutiveFailures += 1;
      state.lastError = err instanceof Error ? err.message : 'poll failed';
      this.logger?.warn({ serviceId, consecutiveFailures: state.consecutiveFailures }, 'fastly-realtime: poll failed');
      return { ok: false, received: 0, error: state.lastError };
    }
  }

  /** Append monotonically newer seconds and prune anything outside the retention window. */
  private ingest(state: ServiceState, samples: FastlyRealtimeSample[]): void {
    for (const s of samples) {
      const last = state.samples[state.samples.length - 1];
      if (last && s.second <= last.second) continue; // de-dup / ignore out-of-order repeats
      state.samples.push(s);
      state.lastSampleAt = s.second * 1000;
    }
    this.prune(state);
  }

  private prune(state: ServiceState): void {
    const cutoff = Math.floor(this.now() / 1000) - this.windowSeconds;
    while (state.samples.length > 0 && state.samples[0].second < cutoff) state.samples.shift();
    // Safety cap: bound memory even if timestamps are unexpectedly sparse or clock-skewed.
    const max = this.windowSeconds + 10;
    if (state.samples.length > max) state.samples.splice(0, state.samples.length - max);
  }

  // ---- Read models --------------------------------------------------------------------------

  snapshot(): FastlyRealtimeSnapshot {
    const capturedAt = new Date(this.now()).toISOString();
    const series = [...this.states.values()].map((st) => {
      this.prune(st);
      const last = st.samples[st.samples.length - 1];
      return {
        serviceId: st.id,
        serviceName: st.name,
        samples: st.samples.slice(),
        latestRequestsPerSecond: last ? last.requests : null,
        latestBandwidthBps: last ? last.bandwidthBytes * 8 : null,
        lastSampleAt: st.lastSampleAt !== null ? new Date(st.lastSampleAt).toISOString() : null,
      };
    });
    return {
      source: this.source,
      capturedAt,
      windowSeconds: this.windowSeconds,
      series,
      provenance: provenanceFor(this.source, capturedAt),
      warnings: [],
    };
  }

  status(): FastlyRealtimeStatus {
    return {
      enabled: this.enabled,
      running: this.started,
      source: this.source,
      windowSeconds: this.windowSeconds,
      services: [...this.states.values()].map((st) => ({
        serviceId: st.id,
        serviceName: st.name,
        running: st.looping,
        sampleCount: st.samples.length,
        lastSampleAt: st.lastSampleAt !== null ? new Date(st.lastSampleAt).toISOString() : null,
        lastPollAt: st.lastPollAt !== null ? new Date(st.lastPollAt).toISOString() : null,
        consecutiveFailures: st.consecutiveFailures,
        lastError: st.lastError,
      })),
    };
  }
}

function backoffMs(failures: number): number {
  return Math.min(30_000, 1000 * Math.max(1, failures));
}

function provenanceFor(source: FastlySource, at: string): FastlyProvenance {
  const notice =
    source === 'disabled'
      ? 'Fastly real-time live-tail is disabled.'
      : 'Fastly real-time CDN telemetry is read-only and informational. RADAR issues no Fastly writes.';
  return { source, synthetic: false, readOnly: true, informationalOnly: true, notice, retrievedAt: at };
}

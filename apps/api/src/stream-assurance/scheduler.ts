// Stream Assurance scheduler: runs enabled profiles on a normal cadence and supports a faster,
// auto-expiring event/key-rotation mode per profile. Each run drives the alert lifecycle via the
// service. Timers are injectable for tests. Self-guarding: disabled unless started, and event mode
// is only started via the API. Never throws out of a tick — a failing run is logged, not fatal.
import type { StreamAssuranceRepository } from '@radar/data';
import type { StreamAssuranceService } from './service.js';

interface Logger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }

export interface StreamAssuranceSchedulerDeps {
  normalIntervalMs?: number; // default 60s
  eventIntervalMs?: number; // default 5s
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (t: ReturnType<typeof setInterval>) => void;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (t: ReturnType<typeof setTimeout>) => void;
  logger?: Logger;
}

const DEFAULT_NORMAL_MS = 60_000;
const DEFAULT_EVENT_MS = 5_000;

export class StreamAssuranceScheduler {
  private readonly normalIntervalMs: number;
  private readonly eventIntervalMs: number;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (t: ReturnType<typeof setInterval>) => void;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (t: ReturnType<typeof setTimeout>) => void;
  private readonly logger?: Logger;
  private normalTimer: ReturnType<typeof setInterval> | null = null;
  private readonly eventTimers = new Map<string, { interval: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout> }>();

  constructor(private readonly repo: StreamAssuranceRepository, private readonly service: StreamAssuranceService, deps: StreamAssuranceSchedulerDeps = {}) {
    this.normalIntervalMs = deps.normalIntervalMs ?? DEFAULT_NORMAL_MS;
    this.eventIntervalMs = deps.eventIntervalMs ?? DEFAULT_EVENT_MS;
    this.setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = deps.clearIntervalImpl ?? ((t) => clearInterval(t));
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? ((t) => clearTimeout(t));
    this.logger = deps.logger;
  }

  start(): void {
    if (this.normalTimer) return;
    this.normalTimer = this.setIntervalImpl(() => void this.runAllEnabled(), this.normalIntervalMs);
  }

  stop(): void {
    if (this.normalTimer) { this.clearIntervalImpl(this.normalTimer); this.normalTimer = null; }
    for (const id of [...this.eventTimers.keys()]) this.stopEventMode(id);
  }

  /** Run every enabled profile once (normal mode). Failures are isolated per profile. */
  async runAllEnabled(): Promise<void> {
    let profiles;
    try { profiles = await this.repo.listProfiles(); }
    catch (e) { this.logger?.warn({ err: e instanceof Error ? e.message : String(e) }, 'stream-assurance: listProfiles failed'); return; }
    for (const p of profiles.filter((x) => x.enabled)) {
      if (this.eventTimers.has(p.id)) continue; // event mode already covers it, faster
      await this.service.run(p.id, 'normal').catch((e) => this.logger?.warn({ profileId: p.id, err: e instanceof Error ? e.message : String(e) }, 'stream-assurance: run failed'));
    }
  }

  /** Start faster event-mode checks for a profile; auto-expires after `durationMs`. */
  startEventMode(profileId: string, durationMs: number): void {
    this.stopEventMode(profileId);
    const interval = this.setIntervalImpl(() => void this.service.run(profileId, 'event').catch((e) => this.logger?.warn({ profileId, err: e instanceof Error ? e.message : String(e) }, 'stream-assurance: event run failed')), this.eventIntervalMs);
    const expiry = this.setTimeoutImpl(() => this.stopEventMode(profileId), Math.max(this.eventIntervalMs, durationMs));
    this.eventTimers.set(profileId, { interval, expiry });
    this.logger?.info({ profileId, durationMs }, 'stream-assurance: event mode started');
  }

  stopEventMode(profileId: string): void {
    const t = this.eventTimers.get(profileId);
    if (!t) return;
    this.clearIntervalImpl(t.interval);
    this.clearTimeoutImpl(t.expiry);
    this.eventTimers.delete(profileId);
  }

  eventModeProfiles(): string[] {
    return [...this.eventTimers.keys()];
  }
}

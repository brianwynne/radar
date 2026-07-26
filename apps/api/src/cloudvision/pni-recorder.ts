// Persists each poll's PNI (private-peering) interface bandwidth into the history store that backs
// the PNI Graphs page, and prunes rows past the retention horizon. Wired to the CloudVision poller's
// onSnapshot hook. READ-ONLY-derived: only numeric rates are stored, never device credentials or raw
// wire data. All DB work is fire-and-forget — a persistence failure is logged, never affecting the poll.
import type { PniBandwidthRepository } from '@radar/data';
import type { NetworkStateSnapshot } from './types.js';

const DEFAULT_RETENTION_HOURS = 25; // just over 24h so the full 24h window is always covered
const DEFAULT_PRUNE_INTERVAL_MS = 30 * 60_000;

interface Logger {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface PniBandwidthRecorderDeps {
  retentionHours?: number;
  pruneIntervalMs?: number;
  now?: () => number;
  logger?: Logger;
}

export class PniBandwidthRecorder {
  private readonly repo: PniBandwidthRepository;
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private lastPruneAt = 0;

  constructor(repo: PniBandwidthRepository, deps: PniBandwidthRecorderDeps = {}) {
    this.repo = repo;
    this.retentionMs = (deps.retentionHours ?? DEFAULT_RETENTION_HOURS) * 3_600_000;
    this.pruneIntervalMs = deps.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
  }

  /** Capture EVERY top-level link (not just eyeball PNIs) from a fresh snapshot, tagged with its
   *  link type and datacentre — logging all links helps find faults, and the UI defaults to showing
   *  only the eyeball links. LAG members and links with no bandwidth data are skipped. Fire-and-forget. */
  record(snapshot: NetworkStateSnapshot): void {
    const dcById = new Map(snapshot.devices.map((d) => [d.id, d.datacentre ?? null]));
    const samples = snapshot.interfaces
      .filter((i) => i.memberOf === null && (i.inBps !== null || i.outBps !== null))
      .map((i) => ({
        deviceId: i.deviceId,
        interfaceName: i.name,
        provider: i.provider,
        linkType: i.linkType,
        datacentre: dcById.get(i.deviceId) ?? null,
        inBps: i.inBps,
        outBps: i.outBps,
      }));
    if (samples.length === 0) return;
    const at = new Date(snapshot.capturedAt);
    void this.repo
      .insertBatch(at, samples)
      .then(() => this.maybePrune())
      .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'pni-bandwidth: persist failed'));
  }

  private maybePrune(): void {
    const now = this.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs) return;
    this.lastPruneAt = now;
    void this.repo
      .prune(new Date(now - this.retentionMs))
      .catch((err) => this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'pni-bandwidth: prune failed'));
  }
}

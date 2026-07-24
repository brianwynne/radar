// bgp.tools connector poller — the read-only runtime. Each cycle: load the watch list, scrape the
// Prometheus feed (authoritative visibility + upstreams) and optionally the table.jsonl dump
// (explicit origin/MOAS), MERGE them, assess, persist changed observations (change-log), and
// reconcile incidents (open active / resolve cleared). Keeps the last-good snapshot + connector
// status. Self-scheduling, no-overlap, backoff on error; never writes to BGP or NS1.
//
// The upstream "learned baseline" is held IN MEMORY (last cycle's upstreams per prefix): it
// re-establishes on the first poll after a restart, which correctly avoids raising missing/new-
// upstream alerts off stale data. firstSeen is likewise tracked in memory for first_observed_at.
import { buildSnapshot, mergeObservations, type AssessmentThresholds, type BuildOptions } from './adapter.js';
import type { BgpToolsMetricsClient, BgpToolsReadClient } from './client.js';
import { planIncidentActions } from './incidents.js';
import type {
  BgpToolsSource, MonitoredPrefix, RoutingIntegrityCounts, RoutingIntegrityState, RoutingIntelligenceSnapshot,
} from './types.js';
import type { BgpToolsIncidentRepository, BgpToolsObservationRepository, IncidentKind } from '@radar/data';

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface BgpToolsPollerConfig {
  enabled: boolean;
  mode: 'mock' | 'live';
  thresholds: AssessmentThresholds;
  fullVisibilityHits: number;
  pollIntervalSeconds: number;
}

export interface BgpToolsPollerOptions {
  observations: BgpToolsObservationRepository;
  incidents: BgpToolsIncidentRepository;
  /** The current watch list (Engineer-managed / discovered). */
  loadMonitored: () => Promise<MonitoredPrefix[]>;
  getConfig: () => BgpToolsPollerConfig;
  /** Prometheus feed client (null when not configured). */
  getMetricsClient: () => BgpToolsMetricsClient | null;
  /** table.jsonl client for hijack/MOAS (null when not configured). */
  getTableClient: () => BgpToolsReadClient | null;
  now?: () => number;
  logger?: Logger;
}

export interface BgpToolsConnectorStatus {
  enabled: boolean;
  mode: 'mock' | 'live';
  running: boolean;
  source: BgpToolsSource;
  monitoredPrefixCount: number;
  overall: RoutingIntegrityState;
  counts: RoutingIntegrityCounts | null;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  snapshotAgeSeconds: number | null;
  openIncidentCount: number | null;
  lastError: string | null;
}

const emptyCounts: RoutingIntegrityCounts = { healthy: 0, degraded: 0, critical: 0, unknown: 0, total: 0 };

export class BgpToolsPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = true;
  private lastSnapshot: RoutingIntelligenceSnapshot | null = null;
  private lastSuccessAt: number | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private openIncidentCount: number | null = null;
  /** In-memory learned baselines (reset on restart — see file header). */
  private priorUpstreams = new Map<string, number[]>();
  private firstSeen = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: BgpToolsPollerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  get snapshot(): RoutingIntelligenceSnapshot | null {
    return this.lastSnapshot;
  }

  status(): BgpToolsConnectorStatus {
    const cfg = this.opts.getConfig();
    const snap = this.lastSnapshot;
    const source: BgpToolsSource = !cfg.enabled ? 'disabled' : cfg.mode === 'mock' ? 'mock' : 'bgptools';
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      running: !this.stopped,
      source,
      monitoredPrefixCount: snap?.counts.total ?? 0,
      overall: snap?.overall ?? 'unknown',
      counts: snap?.counts ?? null,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      snapshotAgeSeconds: this.lastSuccessAt ? Math.max(0, (this.now() - this.lastSuccessAt) / 1000) : null,
      openIncidentCount: this.openIncidentCount,
      lastError: this.lastError,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private schedule(seconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), Math.max(1, seconds) * 1000);
  }

  private async tick(): Promise<void> {
    const cfg = this.opts.getConfig();
    try {
      if (cfg.enabled) await this.poll();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'poll failed';
      this.opts.logger?.error({ err: this.lastError }, 'bgptools: poll cycle failed');
    } finally {
      this.schedule(cfg.pollIntervalSeconds);
    }
  }

  /** Run one poll cycle and return the snapshot. Safe to call directly (tests). */
  async poll(): Promise<RoutingIntelligenceSnapshot> {
    if (this.polling) return this.lastSnapshot ?? this.emptySnapshot();
    this.polling = true;
    this.lastPollAt = this.now();
    try {
      const cfg = this.opts.getConfig();
      let monitored = await this.opts.loadMonitored();
      const observedAt = new Date(this.now());

      const metricsClient = this.opts.getMetricsClient();
      const tableClient = this.opts.getTableClient();
      const metrics = metricsClient ? await metricsClient.fetchMetrics() : null;
      // Auto-discover the watch list from the Prometheus feed when nothing is explicitly configured:
      // the account's own monitored prefixes, each with its expected origin = the ASN the feed
      // attributes it to. An Engineer can still add specific prefixes (with a chosen expected origin
      // for hijack detection); those take precedence via loadMonitored.
      if (monitored.length === 0 && metrics && metrics.prefixes.length > 0) {
        monitored = metrics.prefixes.map((p) => ({ prefix: p.prefix, addressFamily: p.prefix.includes(':') ? 'ipv6' as const : 'ipv4' as const, expectedOriginAsn: p.originAsn }));
      }
      const table = tableClient ? await tableClient.fetchObservations(monitored) : null;
      const raws = mergeObservations(monitored, metrics, table, observedAt);

      const source: BgpToolsSource = !cfg.enabled ? 'disabled' : cfg.mode === 'mock' ? 'mock' : 'bgptools';
      const buildOpts: BuildOptions = {
        now: this.now(),
        fullVisibilityHits: cfg.fullVisibilityHits,
        thresholds: cfg.thresholds,
        source,
        synthetic: cfg.mode === 'mock',
        firstSeen: this.firstSeen,
        priorUpstreams: this.priorUpstreams,
      };
      const snapshot = buildSnapshot(monitored, raws, buildOpts);

      // Persist changed observations (change-log) and refresh the in-memory baselines.
      for (const raw of raws) {
        if (!this.firstSeen.has(raw.prefix)) this.firstSeen.set(raw.prefix, observedAt.getTime());
        if (raw.upstreams !== undefined) this.priorUpstreams.set(raw.prefix, [...raw.upstreams]);
        try {
          await this.opts.observations.record({ prefix: raw.prefix, addressFamily: raw.addressFamily, origins: raw.origins, observedAt, source });
        } catch (err) {
          this.opts.logger?.warn({ prefix: raw.prefix, err: err instanceof Error ? err.message : 'error' }, 'bgptools: observation persist failed');
        }
      }

      // Reconcile incidents against what is currently open.
      const open = await this.opts.incidents.list({ openOnly: true });
      const openByPrefix = new Map<string, Set<IncidentKind>>();
      for (const i of open) {
        const set = openByPrefix.get(i.prefix) ?? new Set<IncidentKind>();
        set.add(i.kind); openByPrefix.set(i.prefix, set);
      }
      const plan = planIncidentActions(snapshot.assessments, openByPrefix, cfg.thresholds);
      for (const s of plan.opens) await this.opts.incidents.openOrUpdate(s);
      for (const r of plan.resolves) await this.opts.incidents.resolveOpen(r.prefix, r.kind, observedAt);
      // Resolve incidents for prefixes NO LONGER monitored (removed from the watch list, or the
      // synthetic fixtures a prior mock run left behind) — otherwise they stay 'active' forever with
      // no assessment to clear them.
      const monitoredPrefixes = new Set(snapshot.assessments.map((a) => a.prefix));
      for (const inc of open) {
        if (!monitoredPrefixes.has(inc.prefix)) await this.opts.incidents.resolveOpen(inc.prefix, inc.kind, observedAt);
      }
      this.openIncidentCount = (await this.opts.incidents.list({ openOnly: true })).length;

      this.lastSnapshot = { ...snapshot, asns: metrics?.asns ?? [] };
      this.lastSuccessAt = this.now();
      this.lastError = null;
      this.opts.logger?.info({ prefixes: monitored.length, overall: snapshot.overall, opened: plan.opens.length, resolved: plan.resolves.length }, 'bgptools: poll ok');
      return this.lastSnapshot;
    } finally {
      this.polling = false;
    }
  }

  private emptySnapshot(): RoutingIntelligenceSnapshot {
    return {
      capturedAt: new Date(this.now()).toISOString(),
      source: 'disabled',
      overall: 'unknown',
      counts: emptyCounts,
      assessments: [],
      provenance: { source: 'disabled', synthetic: false, readOnly: true, note: 'not connected' },
      warnings: [],
    };
  }
}

// bgp.tools connector MANAGER — owns the single (stable) poller and the effective connection, and
// is the ONLY place a stored secret (the Prometheus monitoring URL, whose UUID is the credential)
// is decrypted. The secret is: never persisted in plaintext; decrypted transiently only when a
// live client is built; never logged or returned to the browser. Without the runtime master key
// the connector degrades to "not connected" rather than leaking or guessing. Env config is the
// base; an Engineer-saved connector_settings row (connector='bgptools') overlays it.
import type { BgpToolsIncidentRepository, BgpToolsObservationRepository, ConnectorSettingsRecord, ConnectorSettingsRepository, MonitoredPrefixRecord } from '@radar/data';
import type { SecretBox } from '../security/secret-box.js';
import { SecretBoxError } from '../security/secret-box.js';
import type { BgpToolsMetricsClient, BgpToolsPing, BgpToolsReadClient } from './client.js';
import type { BgpToolsConfig } from './config.js';
import { HttpBgpToolsClient } from './http-client.js';
import { MockBgpToolsClient } from './mock-client.js';
import { BgpToolsPoller, type BgpToolsPollerConfig } from './poller.js';
import { PrometheusBgpToolsClient } from './prometheus-client.js';
import type { BgpToolsSource, MonitoredPrefix } from './types.js';

const CONNECTOR = 'bgptools';

export interface AuditSink {
  record(event: { action: string; actor?: { subject?: string; roles?: string[] }; details?: Record<string, unknown>; correlationId?: string }): void | Promise<void>;
}

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface BgpToolsConnectionView {
  connector: 'bgptools';
  enabled: boolean;
  mode: 'mock' | 'live';
  /** Host of the Prometheus URL for display — NEVER the full URL or the UUID. */
  prometheusHost: string | null;
  tableEnabled: boolean;
  monitoredPrefixCount: number;
  /** Whether a Prometheus URL is stored — the URL itself is never returned. */
  prometheusUrlConfigured: boolean;
  prometheusUrlSetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  source: 'database' | 'environment';
  masterKeyAvailable: boolean;
  /** Non-fatal reason the connector isn't fully live (e.g. no URL) — never a secret. */
  degraded: string | null;
}

export interface BgpToolsConnectionInput {
  enabled?: boolean;
  mode?: 'mock' | 'live';
  tableEnabled?: boolean;
  /** Write-only full Prometheus URL. Omitted/blank ⇒ retain the stored one; non-empty ⇒ replace. */
  prometheusUrl?: string;
  /** Explicitly remove the stored Prometheus URL. */
  clearPrometheusUrl?: boolean;
}

export class BgpToolsManagerError extends Error {
  constructor(readonly code: 'MASTER_KEY_UNAVAILABLE' | 'INVALID_URL' | 'NO_REPOSITORY', message: string) {
    super(message);
    this.name = 'BgpToolsManagerError';
  }
}

export interface BgpToolsManagerDeps {
  baseConfig: BgpToolsConfig;
  repository?: ConnectorSettingsRepository;
  secretBox?: SecretBox | null;
  /** Source of the monitored watch list; falls back to the base config's prefixes. */
  loadMonitoredPrefixes?: () => Promise<MonitoredPrefixRecord[]>;
  audit?: AuditSink;
  now?: () => number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
};

export class BgpToolsConnectorManager {
  private readonly base: BgpToolsConfig;
  private readonly repo?: ConnectorSettingsRepository;
  private readonly secretBox?: SecretBox | null;
  private readonly audit?: AuditSink;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly fetchImpl?: typeof fetch;
  private readonly loadMonitoredPrefixes?: () => Promise<MonitoredPrefixRecord[]>;

  private persisted: ConnectorSettingsRecord | null = null;
  private metricsClient: BgpToolsMetricsClient | null = null;
  private tableClient: BgpToolsReadClient | null = null;
  private source: BgpToolsSource = 'disabled';
  private degraded: string | null = null;
  private readonly poller: BgpToolsPoller;

  constructor(deps: BgpToolsManagerDeps & { observations: BgpToolsObservationRepository; incidents: BgpToolsIncidentRepository }) {
    this.base = deps.baseConfig;
    this.repo = deps.repository;
    this.secretBox = deps.secretBox ?? null;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl;
    this.loadMonitoredPrefixes = deps.loadMonitoredPrefixes;
    this.rebuildClients();
    this.poller = new BgpToolsPoller({
      observations: deps.observations,
      incidents: deps.incidents,
      loadMonitored: () => this.loadMonitored(),
      getConfig: () => this.pollerConfig(),
      getMetricsClient: () => this.metricsClient,
      getTableClient: () => this.tableClient,
      now: this.now,
      logger: this.logger,
    });
  }

  async init(): Promise<void> {
    if (this.repo) {
      try { this.persisted = await this.repo.get(CONNECTOR); }
      catch (err) { this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'bgptools: failed to load persisted connector settings'); }
    }
    this.rebuildClients();
  }

  getPoller(): BgpToolsPoller { return this.poller; }
  start(): void { this.poller.start(); }
  stop(): void { this.poller.stop(); }

  private effEnabled(): boolean { return this.persisted?.enabled ?? this.base.enabled; }
  private effMode(): 'mock' | 'live' { return (this.persisted?.mode as 'mock' | 'live' | undefined) ?? this.base.mode; }

  private pollerConfig(): BgpToolsPollerConfig {
    return {
      enabled: this.effEnabled(),
      mode: this.effMode(),
      thresholds: this.base.thresholds,
      fullVisibilityHits: this.base.fullVisibilityHits,
      pollIntervalSeconds: this.base.pollIntervalSeconds,
    };
  }

  private async loadMonitored(): Promise<MonitoredPrefix[]> {
    if (this.loadMonitoredPrefixes) {
      const rows = await this.loadMonitoredPrefixes();
      if (rows.length > 0) return rows.map((r) => ({ prefix: r.prefix, addressFamily: r.addressFamily, expectedOriginAsn: r.expectedOriginAsn, description: r.description }));
    }
    return this.base.monitoredPrefixes;
  }

  /** Resolve the effective Prometheus URL, decrypting the stored secret when present. The ONLY
   *  place the URL is decrypted. Returns null (and sets `degraded`) when unavailable. */
  private resolvePrometheusUrl(): string | null {
    if (this.persisted?.tokenCiphertext && this.persisted.tokenNonce && this.persisted.tokenTag) {
      if (!this.secretBox) { this.degraded = 'Master key unavailable; the stored Prometheus URL cannot be decrypted.'; return null; }
      try {
        return this.secretBox.open({ ciphertext: this.persisted.tokenCiphertext, nonce: this.persisted.tokenNonce, tag: this.persisted.tokenTag });
      } catch {
        this.degraded = 'Stored Prometheus URL could not be decrypted (master key changed or data tampered).';
        return null;
      }
    }
    return this.base.prometheusUrl ?? null;
  }

  /** Rebuild the live/mock clients from the effective settings. Never throws; sets `degraded`. */
  private rebuildClients(): void {
    this.degraded = null;
    this.metricsClient = null;
    this.tableClient = null;
    if (!this.effEnabled()) { this.source = 'disabled'; return; }

    if (this.effMode() === 'mock') {
      this.source = 'mock';
      this.tableClient = new MockBgpToolsClient({ scenario: (this.base.mockScenario as never) ?? undefined, now: this.now });
      return;
    }

    // Live.
    this.source = 'bgptools';
    const url = this.resolvePrometheusUrl();
    if (url) {
      try {
        this.metricsClient = new PrometheusBgpToolsClient({ metricsUrl: url, userAgent: this.base.userAgent, timeoutMs: this.base.timeoutSeconds * 1000, fetchImpl: this.fetchImpl, now: this.now });
      } catch (err) {
        this.degraded = err instanceof Error ? err.message : 'Prometheus client could not be built.';
      }
    } else if (!this.degraded) {
      this.degraded = 'No Prometheus monitoring URL configured.';
    }
    if (this.base.tableEnabled && /\S+@\S+/.test(this.base.userAgent)) {
      try {
        this.tableClient = new HttpBgpToolsClient({ tableUrl: this.base.tableUrl, userAgent: this.base.userAgent, token: this.base.token, timeoutMs: this.base.timeoutSeconds * 1000, fetchImpl: this.fetchImpl, now: this.now });
      } catch (err) {
        this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'bgptools: table client unavailable');
      }
    }
  }

  view(): BgpToolsConnectionView {
    const p = this.persisted;
    return {
      connector: 'bgptools',
      enabled: this.effEnabled(),
      mode: this.effMode(),
      prometheusHost: hostOf(this.base.prometheusUrl) ?? (p?.endpoint ?? null),
      tableEnabled: this.base.tableEnabled,
      monitoredPrefixCount: this.base.monitoredPrefixes.length,
      prometheusUrlConfigured: Boolean(p?.tokenCiphertext) || Boolean(this.base.prometheusUrl),
      prometheusUrlSetAt: p?.tokenSetAt ? p.tokenSetAt.toISOString() : null,
      updatedBy: p?.updatedBy ?? null,
      updatedAt: p?.updatedAt ? p.updatedAt.toISOString() : null,
      source: p ? 'database' : 'environment',
      masterKeyAvailable: Boolean(this.secretBox),
      degraded: this.degraded,
    };
  }

  /** Engineer-only. Persists the settings (sealing the URL when replaced), reloads and rebuilds. */
  async updateSettings(input: BgpToolsConnectionInput, actor: { subject?: string; roles?: string[]; correlationId?: string }): Promise<BgpToolsConnectionView> {
    if (!this.repo) throw new BgpToolsManagerError('NO_REPOSITORY', 'Connector settings persistence is not configured.');

    let tokenAction: 'retain' | 'replace' | 'clear' = 'retain';
    let sealed: { ciphertext: Buffer; nonce: Buffer; tag: Buffer } | undefined;
    let endpointHost: string | null = this.persisted?.endpoint ?? hostOf(this.base.prometheusUrl);

    if (input.clearPrometheusUrl) {
      tokenAction = 'clear';
      endpointHost = null;
    } else if (input.prometheusUrl && input.prometheusUrl.trim().length > 0) {
      const url = input.prometheusUrl.trim();
      if (!/^https?:\/\/\S+$/.test(url)) throw new BgpToolsManagerError('INVALID_URL', 'The Prometheus URL must be a valid http(s) URL.');
      if (!this.secretBox) throw new BgpToolsManagerError('MASTER_KEY_UNAVAILABLE', 'The runtime master key is unavailable; a URL cannot be stored securely.');
      const s = this.secretBox.seal(url);
      sealed = { ciphertext: s.ciphertext, nonce: s.nonce, tag: s.tag };
      tokenAction = 'replace';
      endpointHost = hostOf(url);
    }

    const enabled = input.enabled ?? this.effEnabled();
    const mode = input.mode ?? this.effMode();
    await this.repo.upsert({
      connector: CONNECTOR,
      enabled,
      mode,
      endpoint: endpointHost,
      verifyTls: true,
      edgeDeviceIds: null,
      updatedBy: actor.subject ?? null,
      tokenAction,
      ...(sealed ? { tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce, tokenTag: sealed.tag } : {}),
    });
    this.persisted = await this.repo.get(CONNECTOR);
    this.rebuildClients();
    await this.audit?.record({ action: 'bgptools.connection.update', actor, details: { enabled, mode, tokenAction }, correlationId: actor.correlationId });
    return this.view();
  }

  /** "Test connection": build a transient client and ping. Never returns or logs the URL. */
  async test(): Promise<{ ok: boolean; source: BgpToolsSource; error?: string; summary?: string }> {
    const source = this.source;
    const client = this.metricsClient ?? this.tableClient;
    if (!this.effEnabled()) return { ok: false, source, error: 'Connector is disabled.' };
    if (!client) return { ok: false, source, error: this.degraded ?? 'No client configured.' };
    try {
      const ping: BgpToolsPing = await client.ping();
      return ping.ok ? { ok: true, source, summary: ping.detail } : { ok: false, source, error: ping.detail };
    } catch (err) {
      const msg = err instanceof SecretBoxError ? 'Secret could not be decrypted.' : err instanceof Error ? err.message : 'test failed';
      return { ok: false, source, error: msg };
    }
  }
}

// Cloudflare connector MANAGER — the execution boundary for the connector's API token. Owns a
// single (stable) poller and reconfigures it when an Engineer changes the connection. The token
// is stored only as AES-256-GCM ciphertext (via the shared connector-settings repository),
// decrypted ONLY here transiently when a live client is built, and never returned/logged/audited.
// The generic connector_settings columns are repurposed for Cloudflare: `endpoint` holds the
// account id, `edge_device_ids` holds the LB zones (CSV). Fails closed when the master key is
// missing/invalid: a token can be neither stored nor decrypted and the connector degrades to
// "not connected" rather than leaking or guessing.
import { createCloudflareClient } from './index.js';
import { CloudflarePoller } from './poller.js';
import type { CloudflareConfig, CloudflareMode } from './config.js';
import type { CloudflareClient, CloudflareSource } from './types.js';
import { ConnectorManagerError, type AuditSink } from '../cloudvision/manager.js';
import type { SecretBox } from '../security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository } from '@radar/data';

const CONNECTOR = 'cloudflare';
/** Placeholder strings the UI may show for a configured token — never accepted as a value. */
const MASK_SENTINELS = new Set(['••••••••', '********', '(configured)', '(unchanged)']);

export interface CloudflareSettingsView {
  connector: 'cloudflare';
  enabled: boolean;
  mode: CloudflareMode;
  accountId: string | null;
  zones: string[];
  /** Whether a token is configured — the token itself is NEVER returned. */
  tokenConfigured: boolean;
  tokenSetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  source: 'database' | 'environment';
  masterKeyAvailable: boolean;
  degraded: string | null;
}

export interface CloudflareSettingsInput {
  enabled?: boolean;
  mode?: CloudflareMode;
  accountId?: string | null;
  zones?: string[] | null;
  /** Write-only. Omitted/blank ⇒ retain the stored token; non-empty ⇒ replace it. */
  token?: string;
  clearToken?: boolean;
}

interface ManagerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface CloudflareManagerDeps {
  baseConfig: CloudflareConfig;
  repository?: ConnectorSettingsRepository;
  secretBox?: SecretBox | null;
  audit?: AuditSink;
  isDevelopment?: boolean;
  now?: () => number;
  logger?: ManagerLogger;
  fetchImpl?: typeof fetch;
}

const csvToList = (s: string | null | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
const listToCsv = (l: string[] | null | undefined): string | null => {
  if (l === null || l === undefined) return null;
  const j = l.map((x) => x.trim()).filter((x) => x.length > 0).join(',');
  return j.length > 0 ? j : null;
};

export class CloudflareConnectorManager {
  private readonly base: CloudflareConfig;
  private readonly repo?: ConnectorSettingsRepository;
  private readonly secretBox?: SecretBox | null;
  private readonly audit?: AuditSink;
  private readonly isDev: boolean;
  private readonly now: () => number;
  private readonly logger?: ManagerLogger;
  private readonly fetchImpl?: typeof fetch;

  private persisted: ConnectorSettingsRecord | null = null;
  private poller: CloudflarePoller;

  constructor(deps: CloudflareManagerDeps) {
    this.base = deps.baseConfig;
    this.repo = deps.repository;
    this.secretBox = deps.secretBox ?? null;
    this.audit = deps.audit;
    this.isDev = deps.isDevelopment ?? false;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl;
    const built = this.buildClient();
    this.poller = new CloudflarePoller({ client: built.client, enabled: built.source !== 'disabled', intervalMs: this.base.pollIntervalSeconds * 1000, maxSampleAgeSeconds: this.base.maxSampleAgeSeconds, now: this.now, logger: this.logger });
  }

  /** Load persisted settings (if a repository is configured) and reconfigure the poller. */
  async init(): Promise<void> {
    if (this.repo) {
      try {
        this.persisted = await this.repo.get(CONNECTOR);
      } catch (err) {
        this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'cloudflare: failed to load persisted connector settings');
      }
    }
    this.applyToPoller();
  }

  getPoller(): CloudflarePoller {
    return this.poller;
  }

  start(): void {
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
  }

  // ---- Effective config resolution (the ONLY place the token is decrypted) -------------------

  private buildClient(): { client: CloudflareClient; source: CloudflareSource; degraded: string | null } {
    const r = this.resolveFields();
    let token: string | undefined;
    let degraded: string | null = null;

    if (r.enabled && r.mode === 'live') {
      if (this.persisted && this.persisted.tokenCiphertext && this.persisted.tokenNonce && this.persisted.tokenTag) {
        if (!this.secretBox) degraded = 'Master key unavailable; the stored token cannot be decrypted.';
        else {
          try {
            token = this.secretBox.open({ ciphertext: this.persisted.tokenCiphertext, nonce: this.persisted.tokenNonce, tag: this.persisted.tokenTag });
          } catch {
            degraded = 'Stored token could not be decrypted (master key changed or data tampered).';
          }
        }
      } else if (!this.persisted) {
        token = this.base.token; // environment-provided token (mounted secret / env)
      }
      if (!degraded && !token) degraded = 'No API token configured.';
      if (!degraded && !r.accountId) degraded = 'No account id configured.';
    }

    const source: CloudflareSource = !r.enabled ? 'disabled' : r.mode === 'mock' ? 'mock' : degraded ? 'disabled' : 'cloudflare';
    const effective: CloudflareConfig = { ...this.base, enabled: source !== 'disabled', mode: r.mode, accountId: r.accountId ?? undefined, token, lbZones: r.zones };
    const client = createCloudflareClient(effective, { now: this.now, logger: this.logger, fetchImpl: this.fetchImpl });
    return { client, source, degraded };
  }

  private resolveFields(): { enabled: boolean; mode: CloudflareMode; accountId: string | null; zones: string[] } {
    const s = this.persisted;
    return {
      enabled: s ? s.enabled : this.base.enabled,
      mode: (s ? s.mode : this.base.mode) as CloudflareMode,
      accountId: s ? s.endpoint : this.base.accountId ?? null,
      zones: s ? csvToList(s.edgeDeviceIds) : this.base.lbZones,
    };
  }

  private applyToPoller(): void {
    const built = this.buildClient();
    this.poller.reconfigure({ client: built.client, enabled: built.source !== 'disabled', intervalMs: this.base.pollIntervalSeconds * 1000 });
    if (built.degraded) this.logger?.warn({ reason: built.degraded }, 'cloudflare: connector degraded');
  }

  // ---- Views + updates ----------------------------------------------------------------------

  getSettingsView(): CloudflareSettingsView {
    const r = this.resolveFields();
    const built = this.buildClient(); // recomputes `degraded` (does not expose the token)
    const s = this.persisted;
    return {
      connector: 'cloudflare',
      enabled: r.enabled,
      mode: r.mode,
      accountId: r.accountId,
      zones: r.zones,
      tokenConfigured: this.tokenConfigured(),
      tokenSetAt: s?.tokenSetAt ? s.tokenSetAt.toISOString() : null,
      updatedBy: s?.updatedBy ?? null,
      updatedAt: s?.updatedAt ? s.updatedAt.toISOString() : null,
      source: s ? 'database' : 'environment',
      masterKeyAvailable: !!this.secretBox,
      degraded: built.degraded,
    };
  }

  private tokenConfigured(): boolean {
    if (this.persisted) return !!(this.persisted.tokenCiphertext && this.persisted.tokenNonce && this.persisted.tokenTag);
    return !!this.base.token; // environment token
  }

  /** Apply an Engineer's change: validate, encrypt-on-replace, persist, audit (no secret),
   *  reconfigure the live poller. Requires a repository (persistence). */
  async updateSettings(input: CloudflareSettingsInput, actor: { subject?: string; roles?: string[]; correlationId?: string }): Promise<CloudflareSettingsView> {
    if (!this.repo) throw new ConnectorManagerError('ENDPOINT_REQUIRED', 'Connector settings persistence is not configured.');

    if (input.token !== undefined && MASK_SENTINELS.has(input.token.trim())) {
      throw new ConnectorManagerError('INVALID_TOKEN_VALUE', 'The masked placeholder is not a valid token value.');
    }

    const current = this.persisted;
    const enabled = input.enabled ?? current?.enabled ?? this.base.enabled;
    const mode: CloudflareMode = input.mode ?? (current?.mode as CloudflareMode) ?? this.base.mode;
    const accountId = input.accountId !== undefined ? (input.accountId?.trim() || null) : current?.endpoint ?? this.base.accountId ?? null;
    const zones = input.zones !== undefined ? listToCsv(input.zones) : current?.edgeDeviceIds ?? listToCsv(this.base.lbZones);

    const suppliedToken = input.token?.trim() ?? '';
    const tokenAction: 'retain' | 'replace' | 'clear' = input.clearToken ? 'clear' : suppliedToken.length > 0 ? 'replace' : 'retain';

    if (tokenAction === 'replace' && !this.secretBox) {
      throw new ConnectorManagerError('MASTER_KEY_UNAVAILABLE', 'Cannot store a token: the runtime master key (/run/secrets/radar_master_key) is not available.');
    }

    // Live requires an account id and a token that will exist AFTER this update.
    if (enabled && mode === 'live') {
      if (!accountId) throw new ConnectorManagerError('ENDPOINT_REQUIRED', 'A live connection requires a Cloudflare account id.');
      const tokenAfter = tokenAction === 'replace' ? true : tokenAction === 'clear' ? false : this.tokenConfigured();
      if (!tokenAfter) throw new ConnectorManagerError('TOKEN_REQUIRED', 'A live connection requires an API token.');
    }

    let sealed: { ciphertext: Buffer; nonce: Buffer; tag: Buffer } | undefined;
    if (tokenAction === 'replace') sealed = this.secretBox!.seal(suppliedToken);

    this.persisted = await this.repo.upsert({
      connector: CONNECTOR,
      enabled,
      mode,
      endpoint: accountId,
      verifyTls: true,
      edgeDeviceIds: zones,
      updatedBy: actor.subject ?? null,
      tokenAction,
      tokenCiphertext: sealed?.ciphertext,
      tokenNonce: sealed?.nonce,
      tokenTag: sealed?.tag,
    });

    await this.audit?.record({
      actorSubject: actor.subject,
      actorRoles: actor.roles,
      action: 'connector.settings.updated',
      resourceType: 'connector',
      resourceKey: CONNECTOR,
      outcome: 'success',
      correlationId: actor.correlationId,
      details: { enabled, mode, accountConfigured: !!accountId, tokenAction },
    });

    this.applyToPoller();
    return this.getSettingsView();
  }

  /** Test the CURRENT effective connection read-only (one snapshot). Never persists, never
   *  returns the token. */
  async test(correlationId?: string): Promise<{ ok: boolean; source: CloudflareSource; error?: string; summary?: { loadBalancers: number; pools: number; origins: number } }> {
    const built = this.buildClient();
    if (built.source === 'disabled') return { ok: false, source: 'disabled', error: built.degraded ?? 'Connector is disabled.' };
    try {
      const snap = await built.client.getSnapshot(correlationId);
      return { ok: true, source: built.source, summary: { loadBalancers: snap.summary.loadBalancerCount, pools: snap.summary.poolCount, origins: snap.summary.originCount } };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'ERROR';
      return { ok: false, source: built.source, error: code };
    }
  }
}

// CloudVision connector MANAGER — the execution boundary for the connector's secret. It owns
// a single (stable) poller and reconfigures it when an Engineer changes the connection. The
// service-account token is:
//   • stored only as AES-256-GCM ciphertext (via the settings repository),
//   • decrypted ONLY here, transiently, at the moment a live client is constructed,
//   • never returned, logged, serialised into a view, or written to an audit entry.
// Non-secret settings come from Postgres when present, otherwise from the environment base
// config. Fails closed: if the master key is missing/invalid a token can be neither stored
// nor decrypted, and the connector degrades to "not connected" rather than leaking or guessing.
import { createCloudVisionClient } from './index.js';
import { CloudVisionPoller } from './poller.js';
import type { CloudVisionConfig, CloudVisionMode } from './config.js';
import type { CloudVisionClient, CloudVisionSource } from './types.js';
import type { SecretBox } from '../security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository } from '@radar/data';

const CONNECTOR = 'cloudvision';
/** Placeholder strings the UI may show for a configured token — never accepted as a value. */
const MASK_SENTINELS = new Set(['••••••••', '********', '(configured)', '(unchanged)']);

export interface AuditSink {
  record(event: { actorSubject?: string; actorRoles?: string[]; action: string; resourceType?: string; resourceKey?: string; outcome: string; correlationId?: string; details?: Record<string, unknown> }): Promise<void>;
}

export interface ConnectorSettingsView {
  connector: 'cloudvision';
  enabled: boolean;
  mode: CloudVisionMode;
  endpoint: string | null;
  verifyTls: boolean;
  edgeDeviceIds: string[];
  /** Whether a token is configured — the token itself is NEVER returned. */
  tokenConfigured: boolean;
  tokenSetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Where the effective settings come from. */
  source: 'database' | 'environment';
  /** Whether the runtime master key is available (needed to store/decrypt a token). */
  masterKeyAvailable: boolean;
  /** Non-fatal reason the connector is not fully live (e.g. missing token) — never a secret. */
  degraded: string | null;
}

export interface ConnectorSettingsInput {
  enabled?: boolean;
  mode?: CloudVisionMode;
  endpoint?: string | null;
  verifyTls?: boolean;
  edgeDeviceIds?: string[] | null;
  /** Write-only. Omitted/blank ⇒ retain the stored token; non-empty ⇒ replace it. */
  token?: string;
  /** Explicitly remove the stored token. */
  clearToken?: boolean;
}

export class ConnectorManagerError extends Error {
  constructor(
    readonly code: 'MASTER_KEY_UNAVAILABLE' | 'ENDPOINT_REQUIRED' | 'TOKEN_REQUIRED' | 'ENDPOINT_INSECURE' | 'INVALID_TOKEN_VALUE',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorManagerError';
  }
}

export interface ConnectorManagerDeps {
  baseConfig: CloudVisionConfig;
  repository?: ConnectorSettingsRepository;
  secretBox?: SecretBox | null;
  audit?: AuditSink;
  isDevelopment?: boolean;
  now?: () => number;
  logger?: ManagerLogger;
  /** Injected into the live client (tests supply a stub; production uses global fetch). */
  fetchImpl?: typeof fetch;
}

interface ManagerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const csvToList = (s: string | null | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
const listToCsv = (l: string[] | null | undefined): string | null => {
  if (l === null || l === undefined) return null;
  const j = l.map((x) => x.trim()).filter((x) => x.length > 0).join(',');
  return j.length > 0 ? j : null;
};

export class CloudVisionConnectorManager {
  private readonly base: CloudVisionConfig;
  private readonly repo?: ConnectorSettingsRepository;
  private readonly secretBox?: SecretBox | null;
  private readonly audit?: AuditSink;
  private readonly isDev: boolean;
  private readonly now: () => number;
  private readonly logger?: ManagerLogger;
  private readonly fetchImpl?: typeof fetch;

  private persisted: ConnectorSettingsRecord | null = null;
  private poller: CloudVisionPoller;

  constructor(deps: ConnectorManagerDeps) {
    this.base = deps.baseConfig;
    this.repo = deps.repository;
    this.secretBox = deps.secretBox ?? null;
    this.audit = deps.audit;
    this.isDev = deps.isDevelopment ?? false;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl;
    // Build the initial poller from the environment base config (persisted settings, if any,
    // are loaded in init()).
    const built = this.buildClient();
    this.poller = new CloudVisionPoller({ client: built.client, source: built.source, intervalMs: this.base.pollIntervalSeconds * 1000, enabled: built.source !== 'disabled', now: this.now, logger: this.logger });
  }

  /** Load persisted settings (if a repository is configured) and reconfigure the poller. */
  async init(): Promise<void> {
    if (this.repo) {
      try {
        this.persisted = await this.repo.get(CONNECTOR);
      } catch (err) {
        this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'cloudvision: failed to load persisted connector settings');
      }
    }
    this.applyToPoller();
  }

  getPoller(): CloudVisionPoller {
    return this.poller;
  }

  start(): void {
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
  }

  // ---- Effective config resolution (the ONLY place the token is decrypted) -------------------

  /** Resolve the current effective settings + a live client. Decrypts the stored token
   *  transiently to construct the client, then lets it go out of scope. */
  private buildClient(): { client: CloudVisionClient; source: CloudVisionSource; degraded: string | null } {
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
      if (!degraded && !token) degraded = 'No service-account token configured.';
      if (!degraded && !r.endpoint) degraded = 'No endpoint configured.';
    }

    const source: CloudVisionSource = !r.enabled ? 'disabled' : r.mode === 'mock' ? 'mock' : degraded ? 'disabled' : 'cloudvision';
    const effective: CloudVisionConfig = { ...this.base, enabled: source !== 'disabled', mode: r.mode, endpoint: r.endpoint ?? undefined, token, verifyTls: r.verifyTls, edgeDeviceIds: r.edgeDeviceIds };
    const client = createCloudVisionClient(effective, { now: this.now, logger: this.logger, fetchImpl: this.fetchImpl });
    return { client, source, degraded };
  }

  private resolveFields(): { enabled: boolean; mode: CloudVisionMode; endpoint: string | null; verifyTls: boolean; edgeDeviceIds: string[] } {
    const s = this.persisted;
    return {
      enabled: s ? s.enabled : this.base.enabled,
      mode: (s ? s.mode : this.base.mode) as CloudVisionMode,
      endpoint: s ? s.endpoint : this.base.endpoint ?? null,
      verifyTls: s ? s.verifyTls : this.base.verifyTls,
      edgeDeviceIds: s ? csvToList(s.edgeDeviceIds) : this.base.edgeDeviceIds,
    };
  }

  private applyToPoller(): void {
    const built = this.buildClient();
    this.poller.reconfigure({ client: built.client, source: built.source, intervalMs: this.base.pollIntervalSeconds * 1000, enabled: built.source !== 'disabled' });
    if (built.degraded) this.logger?.warn({ reason: built.degraded }, 'cloudvision: connector degraded');
  }

  // ---- Views + updates ----------------------------------------------------------------------

  getSettingsView(): ConnectorSettingsView {
    const r = this.resolveFields();
    const built = this.buildClient(); // recomputes `degraded` (does not expose the token)
    const s = this.persisted;
    return {
      connector: 'cloudvision',
      enabled: r.enabled,
      mode: r.mode,
      endpoint: r.endpoint,
      verifyTls: r.verifyTls,
      edgeDeviceIds: r.edgeDeviceIds,
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
  async updateSettings(input: ConnectorSettingsInput, actor: { subject?: string; roles?: string[]; correlationId?: string }): Promise<ConnectorSettingsView> {
    if (!this.repo) throw new ConnectorManagerError('ENDPOINT_REQUIRED', 'Connector settings persistence is not configured.');

    // Reject a masked placeholder ever being submitted as the token value.
    if (input.token !== undefined && MASK_SENTINELS.has(input.token.trim())) {
      throw new ConnectorManagerError('INVALID_TOKEN_VALUE', 'The masked placeholder is not a valid token value.');
    }

    const current = this.persisted;
    const enabled = input.enabled ?? current?.enabled ?? this.base.enabled;
    const mode: CloudVisionMode = input.mode ?? (current?.mode as CloudVisionMode) ?? this.base.mode;
    const endpoint = input.endpoint !== undefined ? (input.endpoint?.trim() || null) : current?.endpoint ?? this.base.endpoint ?? null;
    const verifyTls = input.verifyTls ?? current?.verifyTls ?? this.base.verifyTls;
    const edgeDeviceIds = input.edgeDeviceIds !== undefined ? listToCsv(input.edgeDeviceIds) : current?.edgeDeviceIds ?? listToCsv(this.base.edgeDeviceIds);

    const suppliedToken = input.token?.trim() ?? '';
    const tokenAction: 'retain' | 'replace' | 'clear' = input.clearToken ? 'clear' : suppliedToken.length > 0 ? 'replace' : 'retain';

    // Fail closed: a token can only be stored when the master key is available.
    if (tokenAction === 'replace' && !this.secretBox) {
      throw new ConnectorManagerError('MASTER_KEY_UNAVAILABLE', 'Cannot store a token: the runtime master key (/run/secrets/radar_master_key) is not available.');
    }

    // Live requires an endpoint and a token that will exist AFTER this update.
    if (enabled && mode === 'live') {
      if (!endpoint) throw new ConnectorManagerError('ENDPOINT_REQUIRED', 'A live connection requires an endpoint.');
      if (!this.isDev && !/^https:\/\//i.test(endpoint)) throw new ConnectorManagerError('ENDPOINT_INSECURE', 'The endpoint must use HTTPS outside development.');
      const tokenAfter = tokenAction === 'replace' ? true : tokenAction === 'clear' ? false : this.tokenConfigured();
      if (!tokenAfter) throw new ConnectorManagerError('TOKEN_REQUIRED', 'A live connection requires a service-account token.');
    }

    // Encrypt the token (unique nonce per write) — plaintext exists only in this scope.
    let sealed: { ciphertext: Buffer; nonce: Buffer; tag: Buffer } | undefined;
    if (tokenAction === 'replace') sealed = this.secretBox!.seal(suppliedToken);

    this.persisted = await this.repo.upsert({
      connector: CONNECTOR,
      enabled,
      mode,
      endpoint,
      verifyTls,
      edgeDeviceIds,
      updatedBy: actor.subject ?? null,
      tokenAction,
      tokenCiphertext: sealed?.ciphertext,
      tokenNonce: sealed?.nonce,
      tokenTag: sealed?.tag,
    });

    // Audit WITHOUT secret material — only the action taken.
    await this.audit?.record({
      actorSubject: actor.subject,
      actorRoles: actor.roles,
      action: 'connector.settings.updated',
      resourceType: 'connector',
      resourceKey: CONNECTOR,
      outcome: 'success',
      correlationId: actor.correlationId,
      details: { enabled, mode, endpointConfigured: !!endpoint, verifyTls, tokenAction },
    });

    this.applyToPoller();
    return this.getSettingsView();
  }

  /** Test the CURRENT effective connection read-only (one snapshot). Never persists, never
   *  returns the token. */
  async test(correlationId?: string): Promise<{ ok: boolean; source: CloudVisionSource; error?: string; summary?: { devices: number; interfaces: number; bgpPeers: number; freshness: string } }> {
    const built = this.buildClient();
    if (built.source === 'disabled') return { ok: false, source: 'disabled', error: built.degraded ?? 'Connector is disabled.' };
    try {
      const snap = await built.client.getSnapshot(correlationId);
      return { ok: true, source: built.source, summary: { devices: snap.devices.length, interfaces: snap.interfaces.length, bgpPeers: snap.bgpPeers.length, freshness: snap.freshness.level } };
    } catch (err) {
      // Error codes are safe (no secret material); redact anything unexpected.
      const code = err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'ERROR';
      return { ok: false, source: built.source, error: code };
    }
  }
}

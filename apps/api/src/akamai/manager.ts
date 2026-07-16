// Akamai connector MANAGER — the execution boundary for the S3 secret access key. Owns a single
// (stable) AkamaiConnector and reconfigures it when an Engineer changes the connection. The S3 secret
// is stored ONLY as AES-256-GCM ciphertext (via the shared connector-settings repository), decrypted
// ONLY here transiently when a live client is built, and never returned/logged/audited. The generic
// connector_settings columns are repurposed: `edge_device_ids` = CP codes (CSV), `endpoint` = a small
// JSON blob of the non-secret S3 settings + CP names + window. Fails closed when the master key is
// missing/invalid. No new migration.
import { AkamaiConnector } from './index.js';
import type { AkamaiConfig } from './config.js';
import { ConnectorManagerError, type AuditSink } from '../cloudvision/manager.js';
import type { SecretBox } from '../security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository } from '@radar/data';

const CONNECTOR = 'akamai';
const MASK_SENTINELS = new Set(['••••••••', '********', '(configured)', '(unchanged)']);

interface S3Blob {
  bucket?: string; region?: string; prefix?: string; accessKeyId?: string;
  pollIntervalSeconds?: number; windowSeconds?: number; names?: Record<string, string>;
}

export interface AkamaiSettingsView {
  connector: 'akamai';
  enabled: boolean;
  cpCodes: string[];
  cpNames: Record<string, string>;
  s3: { bucket: string; region: string; prefix: string; accessKeyId: string; pollIntervalSeconds: number };
  windowSeconds: number;
  /** Whether an S3 secret key is configured — the key itself is NEVER returned. */
  secretConfigured: boolean;
  secretSetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  source: 'database' | 'environment';
  masterKeyAvailable: boolean;
  connected: boolean;
  degraded: string | null;
}

export interface AkamaiSettingsInput {
  enabled?: boolean;
  cpCodes?: string[] | null;
  cpNames?: Record<string, string> | null;
  bucket?: string | null;
  region?: string | null;
  prefix?: string | null;
  accessKeyId?: string | null;
  pollIntervalSeconds?: number | null;
  windowSeconds?: number | null;
  /** Write-only S3 secret access key. Omitted/blank retains; non-empty replaces. */
  secretKey?: string;
  clearSecret?: boolean;
}

interface ManagerLogger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

export interface AkamaiManagerDeps {
  baseConfig: AkamaiConfig;
  repository?: ConnectorSettingsRepository;
  secretBox?: SecretBox | null;
  audit?: AuditSink;
  now?: () => number;
  logger?: ManagerLogger;
  fetchImpl?: typeof fetch;
}

const csvToList = (s: string | null | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
const listToCsv = (l: string[] | null | undefined): string | null => {
  if (l == null) return null;
  const j = l.map((x) => x.trim()).filter((x) => x.length > 0).join(',');
  return j.length > 0 ? j : null;
};
function parseBlob(s: string | null): S3Blob {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export class AkamaiConnectorManager {
  private readonly base: AkamaiConfig;
  private readonly repo?: ConnectorSettingsRepository;
  private readonly secretBox?: SecretBox | null;
  private readonly audit?: AuditSink;
  private readonly logger?: ManagerLogger;
  private persisted: ConnectorSettingsRecord | null = null;
  private connector: AkamaiConnector;

  constructor(deps: AkamaiManagerDeps) {
    this.base = deps.baseConfig;
    this.repo = deps.repository;
    this.secretBox = deps.secretBox ?? null;
    this.audit = deps.audit;
    this.logger = deps.logger;
    this.connector = new AkamaiConnector(this.base, { now: deps.now, logger: deps.logger, fetchImpl: deps.fetchImpl });
  }

  async init(): Promise<void> {
    if (this.repo) {
      try { this.persisted = await this.repo.get(CONNECTOR); }
      catch (err) { this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'akamai: failed to load persisted settings'); }
    }
    this.connector.reconfigure(this.buildEffective().config);
  }

  getConnector(): AkamaiConnector { return this.connector; }
  start(): void { this.connector.start(); }
  stop(): void { this.connector.stop(); }

  /** The ONLY place the S3 secret is decrypted. Fails closed: missing/invalid master key ⇒ no secret. */
  private buildEffective(): { config: AkamaiConfig; degraded: string | null; secretConfigured: boolean } {
    const s = this.persisted;
    const blob = parseBlob(s?.endpoint ?? null);
    const enabled = s ? s.enabled : this.base.enabled;
    let secret = s ? '' : this.base.s3.secretAccessKey; // env secret only when no DB row
    let degraded: string | null = null;
    const hasStoredSecret = !!(s && s.tokenCiphertext && s.tokenNonce && s.tokenTag);
    if (hasStoredSecret) {
      if (!this.secretBox) degraded = 'Master key unavailable; the stored S3 secret cannot be decrypted.';
      else {
        try { secret = this.secretBox.open({ ciphertext: s!.tokenCiphertext!, nonce: s!.tokenNonce!, tag: s!.tokenTag! }); }
        catch { degraded = 'Stored S3 secret could not be decrypted (master key changed or data tampered).'; }
      }
    }
    const config: AkamaiConfig = {
      enabled,
      windowSeconds: blob.windowSeconds ?? this.base.windowSeconds,
      cpCodes: s ? csvToList(s.edgeDeviceIds) : this.base.cpCodes,
      cpNames: blob.names ?? this.base.cpNames,
      ingestSecret: this.base.ingestSecret, // env-only (not UI-managed)
      s3: {
        bucket: blob.bucket ?? this.base.s3.bucket,
        region: blob.region ?? this.base.s3.region,
        prefix: blob.prefix ?? this.base.s3.prefix,
        accessKeyId: blob.accessKeyId ?? this.base.s3.accessKeyId,
        secretAccessKey: secret,
        pollIntervalSeconds: blob.pollIntervalSeconds ?? this.base.s3.pollIntervalSeconds,
      },
    };
    return { config, degraded, secretConfigured: hasStoredSecret || (!s && this.base.s3.secretAccessKey.length > 0) };
  }

  getSettingsView(): AkamaiSettingsView {
    const { config, degraded, secretConfigured } = this.buildEffective();
    const s = this.persisted;
    return {
      connector: 'akamai',
      enabled: config.enabled,
      cpCodes: config.cpCodes,
      cpNames: config.cpNames,
      s3: { bucket: config.s3.bucket, region: config.s3.region, prefix: config.s3.prefix, accessKeyId: config.s3.accessKeyId, pollIntervalSeconds: config.s3.pollIntervalSeconds },
      windowSeconds: config.windowSeconds,
      secretConfigured,
      secretSetAt: s?.tokenSetAt ? s.tokenSetAt.toISOString() : null,
      updatedBy: s?.updatedBy ?? null,
      updatedAt: s?.updatedAt ? s.updatedAt.toISOString() : null,
      source: s ? 'database' : 'environment',
      masterKeyAvailable: !!this.secretBox,
      connected: this.connector.connected(),
      degraded,
    };
  }

  async updateSettings(input: AkamaiSettingsInput, actor: { subject?: string; roles?: string[]; correlationId?: string }): Promise<AkamaiSettingsView> {
    if (!this.repo) throw new ConnectorManagerError('ENDPOINT_REQUIRED', 'Connector settings persistence is not configured.');
    if (input.secretKey !== undefined && MASK_SENTINELS.has(input.secretKey.trim())) {
      throw new ConnectorManagerError('INVALID_TOKEN_VALUE', 'The masked placeholder is not a valid secret value.');
    }
    const cur = this.persisted;
    const curBlob = parseBlob(cur?.endpoint ?? null);
    const enabled = input.enabled ?? cur?.enabled ?? this.base.enabled;
    const cpCodes = input.cpCodes !== undefined ? listToCsv(input.cpCodes) : cur?.edgeDeviceIds ?? listToCsv(this.base.cpCodes);

    const blob: S3Blob = {
      bucket: input.bucket !== undefined ? (input.bucket?.trim() || undefined) : curBlob.bucket ?? (this.base.s3.bucket || undefined),
      region: input.region !== undefined ? (input.region?.trim() || undefined) : curBlob.region ?? this.base.s3.region,
      prefix: input.prefix !== undefined ? (input.prefix?.trim() || undefined) : curBlob.prefix ?? (this.base.s3.prefix || undefined),
      accessKeyId: input.accessKeyId !== undefined ? (input.accessKeyId?.trim() || undefined) : curBlob.accessKeyId ?? (this.base.s3.accessKeyId || undefined),
      pollIntervalSeconds: input.pollIntervalSeconds ?? curBlob.pollIntervalSeconds ?? this.base.s3.pollIntervalSeconds,
      windowSeconds: input.windowSeconds ?? curBlob.windowSeconds ?? this.base.windowSeconds,
      names: input.cpNames !== undefined ? (input.cpNames ?? {}) : curBlob.names ?? this.base.cpNames,
    };

    const supplied = input.secretKey?.trim() ?? '';
    const tokenAction: 'retain' | 'replace' | 'clear' = input.clearSecret ? 'clear' : supplied.length > 0 ? 'replace' : 'retain';
    if (tokenAction === 'replace' && !this.secretBox) {
      throw new ConnectorManagerError('MASTER_KEY_UNAVAILABLE', 'Cannot store an S3 secret: the runtime master key is not available.');
    }
    const sealed = tokenAction === 'replace' ? this.secretBox!.seal(supplied) : undefined;

    this.persisted = await this.repo.upsert({
      connector: CONNECTOR, enabled, mode: 's3', endpoint: JSON.stringify(blob), verifyTls: true,
      edgeDeviceIds: cpCodes, updatedBy: actor.subject ?? null,
      tokenAction, tokenCiphertext: sealed?.ciphertext, tokenNonce: sealed?.nonce, tokenTag: sealed?.tag,
    });

    await this.audit?.record({
      actorSubject: actor.subject, actorRoles: actor.roles, action: 'connector.settings.updated',
      resourceType: 'connector', resourceKey: CONNECTOR, outcome: 'success', correlationId: actor.correlationId,
      details: { enabled, cpCodes: cpCodes ? csvToList(cpCodes).length : 0, bucket: blob.bucket ?? '', tokenAction },
    });

    this.connector.reconfigure(this.buildEffective().config);
    return this.getSettingsView();
  }

  /** Read-only connection test against the CURRENT effective settings. Never persists, never returns the secret. */
  async test(): Promise<{ ok: boolean; source: string; error?: string; summary?: { objects: number } }> {
    const r = await this.connector.testConnection();
    return r.ok ? { ok: true, source: 'akamai', summary: { objects: r.objects ?? 0 } } : { ok: false, source: 'disabled', error: r.error };
  }
}

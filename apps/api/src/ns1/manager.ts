// NS1 connector MANAGER — the execution boundary for the read-only NS1 API key. Owns the stable
// ReconfigurableNs1ReadClient and swaps its inner (mock ⇄ live) when an Engineer changes the
// connection on the Integrations page. The key is stored ONLY as AES-256-GCM ciphertext (via the
// shared connector-settings repository), decrypted ONLY here transiently to build the live client,
// and never returned/logged/audited. Fails closed: without the master key the key can be neither
// stored nor decrypted and NS1 stays in mock rather than leaking or guessing. The generic
// connector_settings columns are reused (connector='ns1'): `endpoint` = NS1 API base, `mode` =
// mock|live. No new migration. RADAR remains READ-ONLY to NS1.
import { createNs1Client } from './index.js';
import { ReconfigurableNs1ReadClient } from './reconfigurable-client.js';
import { createNs1RecordWriter, ReconfigurableNs1RecordWriter, type Ns1RecordWriter } from './record-writer.js';
import type { Ns1Config, RadarMode } from './config.js';
import { ConnectorManagerError, type AuditSink } from '../cloudvision/manager.js';
import type { SecretBox } from '../security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository } from '@radar/data';

const CONNECTOR = 'ns1';
const WRITE_CONNECTOR = 'ns1-write'; // the WRITE key lives in its own settings row (its own credential)
const MASK_SENTINELS = new Set(['••••••••', '********', '(configured)', '(unchanged)']);

export interface Ns1SettingsView {
  connector: 'ns1';
  mode: RadarMode;
  apiBase: string;
  /** Whether the READ key is configured — the key itself is NEVER returned. */
  keyConfigured: boolean;
  keySetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  source: 'database' | 'environment';
  /** Effective live vs mock after resolution (live needs a key + the master key to decrypt it). */
  live: boolean;
  masterKeyAvailable: boolean;
  degraded: string | null;
  // ---- WRITE key (the guarded create/clone path) ----
  /** Whether the guarded write path is enabled at all (env NS1_WRITE_ENABLED — the safety gate). */
  writeEnabled: boolean;
  /** The allow-list of record names that may be created (env NS1_WRITE_ALLOW). */
  writeAllow: string[];
  /** Whether a WRITE key is configured — never returned. */
  writeKeyConfigured: boolean;
  writeKeySetAt: string | null;
  /** True when the write path is fully live (enabled + mode live + a decryptable write key). */
  writeLive: boolean;
}

export interface Ns1SettingsInput {
  mode?: RadarMode;
  apiBase?: string | null;
  /** Write-only. Omitted/blank ⇒ retain the stored READ key; non-empty ⇒ replace it. */
  key?: string;
  clearKey?: boolean;
  /** Write-only. The WRITE key (create/clone). Omitted/blank ⇒ retain; non-empty ⇒ replace. */
  writeKey?: string;
  clearWriteKey?: boolean;
}

interface ManagerLogger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

export interface Ns1ManagerDeps {
  baseConfig: Ns1Config;
  repository?: ConnectorSettingsRepository;
  secretBox?: SecretBox | null;
  audit?: AuditSink;
  logger?: ManagerLogger;
  fetchImpl?: typeof fetch;
}

export class Ns1ConnectorManager {
  private readonly base: Ns1Config;
  private readonly repo?: ConnectorSettingsRepository;
  private readonly secretBox?: SecretBox | null;
  private readonly audit?: AuditSink;
  private readonly logger?: ManagerLogger;
  private readonly fetchImpl?: typeof fetch;
  private persisted: ConnectorSettingsRecord | null = null;
  private persistedWrite: ConnectorSettingsRecord | null = null;
  private readonly client: ReconfigurableNs1ReadClient;
  private readonly writer: ReconfigurableNs1RecordWriter;

  constructor(deps: Ns1ManagerDeps) {
    this.base = deps.baseConfig;
    this.repo = deps.repository;
    this.secretBox = deps.secretBox ?? null;
    this.audit = deps.audit;
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl;
    this.client = new ReconfigurableNs1ReadClient(createNs1Client(this.base, { fetchImpl: this.fetchImpl }));
    this.writer = new ReconfigurableNs1RecordWriter(createNs1RecordWriter(this.base, this.fetchImpl));
  }

  async init(): Promise<void> {
    if (this.repo) {
      try { this.persisted = await this.repo.get(CONNECTOR); }
      catch (err) { this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'ns1: failed to load persisted settings'); }
      try { this.persistedWrite = await this.repo.get(WRITE_CONNECTOR); }
      catch (err) { this.logger?.warn({ code: err instanceof Error ? err.name : 'error' }, 'ns1: failed to load write-key settings'); }
    }
    this.applyToClient();
    this.applyToWriter();
  }

  getClient(): ReconfigurableNs1ReadClient { return this.client; }
  /** The stable record writer — its inner is rebuilt when the write key / mode changes. */
  getRecordWriter(): Ns1RecordWriter { return this.writer; }

  /** Effective connector state for provenance and snapshot labels — reflects the live⇄mock
   *  swaps the manager applies at runtime, unlike the startup config. No key exposed. */
  effectiveConnection(): { mode: RadarMode; baseUrl: string } {
    const e = this.resolveEffective();
    return { mode: e.mode, baseUrl: e.baseUrl };
  }

  /** The ONE place the NS1 key is decrypted. Fails closed to mock when the key can't be resolved. */
  private resolveEffective(): { mode: RadarMode; baseUrl: string; apiKey?: string; source: 'ns1' | 'mock'; degraded: string | null } {
    const s = this.persisted;
    const requestedMode = (s ? s.mode : this.base.mode) as RadarMode;
    const baseUrl = (s?.endpoint || this.base.baseUrl).replace(/\/+$/, '');
    let apiKey: string | undefined;
    let degraded: string | null = null;

    if (requestedMode === 'live') {
      if (s && s.tokenCiphertext && s.tokenNonce && s.tokenTag) {
        if (!this.secretBox) degraded = 'Master key unavailable; the stored NS1 key cannot be decrypted.';
        else {
          try { apiKey = this.secretBox.open({ ciphertext: s.tokenCiphertext, nonce: s.tokenNonce, tag: s.tokenTag }); }
          catch { degraded = 'Stored NS1 key could not be decrypted (master key changed or data tampered).'; }
        }
      } else if (!s) {
        apiKey = this.base.apiKey; // environment-provided key
      }
      if (!degraded && !apiKey) degraded = 'Live mode requires a read-only NS1 API key.';
    }

    const effectiveMode: RadarMode = requestedMode === 'live' && apiKey ? 'live' : 'mock';
    return { mode: effectiveMode, baseUrl, apiKey, source: effectiveMode === 'live' ? 'ns1' : 'mock', degraded };
  }

  private applyToClient(): { source: string; degraded: string | null } {
    const e = this.resolveEffective();
    const cfg: Ns1Config = { ...this.base, mode: e.mode, baseUrl: e.baseUrl, apiKey: e.apiKey };
    this.client.setInner(createNs1Client(cfg, { fetchImpl: this.fetchImpl }));
    if (e.degraded) this.logger?.warn({ reason: e.degraded }, 'ns1: connector degraded');
    return { source: e.source, degraded: e.degraded };
  }

  private keyConfigured(): boolean {
    if (this.persisted) return !!(this.persisted.tokenCiphertext && this.persisted.tokenNonce && this.persisted.tokenTag);
    return !!this.base.apiKey;
  }

  private writeKeyConfigured(): boolean {
    if (this.persistedWrite) return !!(this.persistedWrite.tokenCiphertext && this.persistedWrite.tokenNonce && this.persistedWrite.tokenTag);
    return !!this.base.writeApiKey;
  }

  /** The ONE place the WRITE key is decrypted. Returns undefined if none/undecryptable. */
  private resolveWriteKey(): string | undefined {
    const w = this.persistedWrite;
    if (w && w.tokenCiphertext && w.tokenNonce && w.tokenTag) {
      if (!this.secretBox) return undefined;
      try { return this.secretBox.open({ ciphertext: w.tokenCiphertext, nonce: w.tokenNonce, tag: w.tokenTag }); }
      catch { return undefined; }
    }
    return this.persistedWrite ? undefined : this.base.writeApiKey; // env fallback only when no DB row
  }

  /** The write GATE — EPHEMERAL and in-memory. Defaults OFF and resets to OFF on every restart, so
   *  writes are always inert until an engineer explicitly flips the switch this session. NOT persisted
   *  (the write key is; the gate is not) — a safety default so a stale "on" can never linger. */
  private writeGate = false;
  private effectiveWriteEnabled(): boolean {
    return this.writeGate;
  }

  /** Rebuild the record writer's inner from the effective mode/baseUrl + write key + gate. The
   *  allow-list always comes from base config. */
  private applyToWriter(): void {
    const e = this.resolveEffective();
    const cfg: Ns1Config = { ...this.base, mode: e.mode, baseUrl: e.baseUrl, writeApiKey: this.resolveWriteKey(), writeEnabled: this.effectiveWriteEnabled() };
    this.writer.setInner(createNs1RecordWriter(cfg, this.fetchImpl));
  }

  /** Toggle the write gate (NS1_WRITE_ENABLED) at runtime — persisted, audited, rebuilds the writer. */
  async setWriteEnabled(enabled: boolean, actor: { subject?: string; roles?: string[]; correlationId?: string }): Promise<Ns1SettingsView> {
    // The gate is EPHEMERAL: flip the in-memory flag only. It is deliberately NOT persisted, so it
    // resets to OFF on every restart and can never linger "on" across sessions or page loads.
    this.writeGate = enabled;
    await this.audit?.record({ actorSubject: actor.subject, actorRoles: actor.roles, action: 'connector.settings.updated', resourceType: 'connector', resourceKey: WRITE_CONNECTOR, outcome: 'success', correlationId: actor.correlationId, details: { writeEnabled: enabled } });
    this.applyToWriter();
    return this.getSettingsView();
  }

  getSettingsView(): Ns1SettingsView {
    const e = this.resolveEffective();
    const s = this.persisted;
    return {
      connector: 'ns1',
      mode: (s ? s.mode : this.base.mode) as RadarMode,
      apiBase: e.baseUrl,
      keyConfigured: this.keyConfigured(),
      keySetAt: s?.tokenSetAt ? s.tokenSetAt.toISOString() : null,
      updatedBy: s?.updatedBy ?? null,
      updatedAt: s?.updatedAt ? s.updatedAt.toISOString() : null,
      source: s ? 'database' : 'environment',
      live: e.source === 'ns1',
      masterKeyAvailable: !!this.secretBox,
      degraded: e.degraded,
      writeEnabled: this.effectiveWriteEnabled(),
      writeAllow: this.base.writeAllow,
      writeKeyConfigured: this.writeKeyConfigured(),
      writeKeySetAt: this.persistedWrite?.tokenSetAt ? this.persistedWrite.tokenSetAt.toISOString() : null,
      writeLive: this.effectiveWriteEnabled() && e.mode === 'live' && !!this.resolveWriteKey(),
    };
  }

  async updateSettings(input: Ns1SettingsInput, actor: { subject?: string; roles?: string[]; correlationId?: string }): Promise<Ns1SettingsView> {
    if (!this.repo) throw new ConnectorManagerError('ENDPOINT_REQUIRED', 'Connector settings persistence is not configured.');
    if (input.key !== undefined && MASK_SENTINELS.has(input.key.trim())) {
      throw new ConnectorManagerError('INVALID_TOKEN_VALUE', 'The masked placeholder is not a valid key value.');
    }
    if (input.writeKey !== undefined && MASK_SENTINELS.has(input.writeKey.trim())) {
      throw new ConnectorManagerError('INVALID_TOKEN_VALUE', 'The masked placeholder is not a valid write-key value.');
    }
    const cur = this.persisted;
    const mode: RadarMode = input.mode ?? (cur?.mode as RadarMode) ?? this.base.mode;
    const apiBase = input.apiBase !== undefined ? (input.apiBase?.trim() || null) : cur?.endpoint ?? null;
    const effectiveBase = (apiBase || this.base.baseUrl).replace(/\/+$/, '');
    if (mode === 'live' && !/^https:\/\//i.test(effectiveBase)) {
      throw new ConnectorManagerError('ENDPOINT_INSECURE', 'The NS1 API base must use HTTPS in live mode.');
    }

    const supplied = input.key?.trim() ?? '';
    const tokenAction: 'retain' | 'replace' | 'clear' = input.clearKey ? 'clear' : supplied.length > 0 ? 'replace' : 'retain';
    if (tokenAction === 'replace' && !this.secretBox) {
      throw new ConnectorManagerError('MASTER_KEY_UNAVAILABLE', 'Cannot store an NS1 key: the runtime master key is not available.');
    }
    if (mode === 'live') {
      const keyAfter = tokenAction === 'replace' ? true : tokenAction === 'clear' ? false : this.keyConfigured();
      if (!keyAfter) throw new ConnectorManagerError('TOKEN_REQUIRED', 'Live mode requires a read-only NS1 API key.');
    }
    const sealed = tokenAction === 'replace' ? this.secretBox!.seal(supplied) : undefined;

    this.persisted = await this.repo.upsert({
      connector: CONNECTOR, enabled: true, mode, endpoint: apiBase, verifyTls: true, edgeDeviceIds: null,
      updatedBy: actor.subject ?? null, tokenAction,
      tokenCiphertext: sealed?.ciphertext, tokenNonce: sealed?.nonce, tokenTag: sealed?.tag,
    });

    // The WRITE key lives in its own settings row (its own credential); handled independently.
    const suppliedWrite = input.writeKey?.trim() ?? '';
    const writeAction: 'retain' | 'replace' | 'clear' = input.clearWriteKey ? 'clear' : suppliedWrite.length > 0 ? 'replace' : 'retain';
    if (writeAction === 'replace' && !this.secretBox) {
      throw new ConnectorManagerError('MASTER_KEY_UNAVAILABLE', 'Cannot store an NS1 write key: the runtime master key is not available.');
    }
    if (writeAction !== 'retain') {
      const sealedWrite = writeAction === 'replace' ? this.secretBox!.seal(suppliedWrite) : undefined;
      // Storing/clearing the write key must NOT flip the gate — preserve the current gate state
      // (the gate defaults OFF and is toggled explicitly via setWriteEnabled / the create-panel switch).
      this.persistedWrite = await this.repo.upsert({
        connector: WRITE_CONNECTOR, enabled: this.effectiveWriteEnabled(), mode, endpoint: apiBase, verifyTls: true, edgeDeviceIds: null,
        updatedBy: actor.subject ?? null, tokenAction: writeAction,
        tokenCiphertext: sealedWrite?.ciphertext, tokenNonce: sealedWrite?.nonce, tokenTag: sealedWrite?.tag,
      });
    }

    await this.audit?.record({
      actorSubject: actor.subject, actorRoles: actor.roles, action: 'connector.settings.updated',
      resourceType: 'connector', resourceKey: CONNECTOR, outcome: 'success', correlationId: actor.correlationId,
      details: { mode, apiBaseConfigured: !!apiBase, tokenAction, writeKeyAction: writeAction },
    });

    this.applyToClient();
    this.applyToWriter();
    return this.getSettingsView();
  }

  /** Read-only connection test against the CURRENT effective client: list zones, report the count. */
  async test(correlationId?: string): Promise<{ ok: boolean; source: string; error?: string; summary?: { zones: number } }> {
    const e = this.resolveEffective();
    if (e.degraded) return { ok: false, source: e.source, error: e.degraded };
    try {
      const zones = await this.client.listZones(correlationId);
      return { ok: true, source: e.source, summary: { zones: Array.isArray(zones) ? zones.length : 0 } };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'ERROR';
      return { ok: false, source: e.source, error: code };
    }
  }
}

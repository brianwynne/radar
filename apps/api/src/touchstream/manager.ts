// Engineer-managed Touchstream connection. This module is the ONLY decryption boundary for the
// Touchstream credentials: env supplies the base config, a `connector_settings` row overlays it, and
// the credential pair is decrypted solely to construct the live client.
//
// TWO SECRETS, ONE CIPHERTEXT. Touchstream needs both an `X-TS-ID` app id and a bearer token. The
// connector_settings row has a single encrypted slot, so the pair is stored as JSON inside it. The
// app id is deliberately encrypted too: it is half of a working credential, and putting it in the
// row's plaintext column would leave half the secret readable in every database backup.
//
// Fails closed: no master key ⇒ a stored credential cannot be used, and the connector stays degraded
// rather than silently running unauthenticated.
import type { ConnectorSettingsRecord, ConnectorSettingsRepository } from '@radar/data';
import type { SecretBox } from '../security/secret-box.js';
import { MockTouchstreamClient } from './mock-client.js';
import { HttpTouchstreamReadClient } from './http-client.js';
import { TouchstreamError, type TouchstreamClient } from './client.js';
import { TouchstreamPoller } from './poller.js';
import type { TouchstreamConfig, TouchstreamMode } from './config.js';

const CONNECTOR = 'touchstream';

interface Logger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

/** Matches `database.audit` exactly. Getting this shape wrong is a build-time-only failure that
 *  `typecheck` catches but a partially-staged commit can hide, so keep it in step. */
export interface AuditSink {
  record(event: {
    actorSubject?: string;
    actorRoles?: string[];
    action: string;
    resourceType?: string;
    resourceKey?: string;
    outcome: string;
    correlationId?: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface TouchstreamManagerDeps {
  baseConfig: TouchstreamConfig;
  repository?: ConnectorSettingsRepository;
  secretBox?: SecretBox | null;
  audit?: AuditSink;
  logger?: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** What the UI may see. The endpoint is shown (it is not secret); neither credential ever is. */
export interface TouchstreamConnectionView {
  connector: 'touchstream';
  enabled: boolean;
  mode: TouchstreamMode;
  endpoint: string | null;
  environment: 'PROD' | 'NPROD';
  appIdConfigured: boolean;
  tokenConfigured: boolean;
  credentialSetAt: string | null;
  updatedBy: string | null;
  /** Set when a credential is stored but cannot be used (missing/invalid master key). */
  degraded: string | null;
  masterKeyAvailable: boolean;
}

export interface TouchstreamConnectionInput {
  enabled?: boolean;
  mode?: TouchstreamMode;
  endpoint?: string | null;
  environment?: 'PROD' | 'NPROD';
  /** Blank/omitted retains what is stored; a value replaces it. Both must be supplied together. */
  appId?: string;
  token?: string;
  clearCredentials?: boolean;
}

/** The credential pair as stored inside the single encrypted slot. */
interface CredentialPair {
  appId: string;
  token: string;
}

const MASKED = /^[•*]+$/;

export class TouchstreamConnectorManager {
  private readonly base: TouchstreamConfig;
  private readonly repo?: ConnectorSettingsRepository;
  private readonly secretBox?: SecretBox | null;
  private readonly audit?: AuditSink;
  private readonly logger?: Logger;
  private readonly fetchImpl?: typeof fetch;

  private persisted: ConnectorSettingsRecord | null = null;
  private degraded: string | null = null;
  private readonly poller: TouchstreamPoller;

  constructor(deps: TouchstreamManagerDeps) {
    this.base = deps.baseConfig;
    this.repo = deps.repository;
    this.secretBox = deps.secretBox ?? null;
    this.audit = deps.audit;
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl;
    this.poller = new TouchstreamPoller({
      client: new MockTouchstreamClient(),
      source: 'mock',
      enabled: false,
      intervalMs: this.base.pollIntervalSeconds * 1000,
      ownedPrefixes: this.base.ownedPrefixes,
      maxSampleAgeSeconds: this.base.maxSampleAgeSeconds,
      logger: deps.logger,
      now: deps.now,
    });
  }

  /** Load any persisted row and configure the poller accordingly. Never throws. */
  async init(): Promise<void> {
    if (this.repo) {
      try {
        this.persisted = await this.repo.get(CONNECTOR);
      } catch (err) {
        this.logger?.warn({ err: describe(err) }, 'touchstream: could not read connector settings');
      }
    }
    this.applyConfig();
  }

  getPoller(): TouchstreamPoller {
    return this.poller;
  }

  /** The client the on-demand history route should use, or null when unconfigured. */
  getClient(): TouchstreamClient | null {
    const eff = this.effective();
    if (!eff.enabled) return null;
    return this.buildClient(eff);
  }

  start(): void {
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
  }

  /** env base with the persisted row overlaid. */
  private effective(): TouchstreamConfig {
    const row = this.persisted;
    if (!row) return this.base;
    const credentials = this.decrypt(row);
    return {
      ...this.base,
      enabled: row.enabled,
      mode: (row.mode === 'live' ? 'live' : 'mock') as TouchstreamMode,
      endpoint: row.endpoint ?? this.base.endpoint,
      appId: credentials?.appId ?? this.base.appId,
      token: credentials?.token ?? this.base.token,
      // The row's spare text column carries the non-secret environment selector.
      environment: row.edgeDeviceIds === 'NPROD' ? 'NPROD' : 'PROD',
    };
  }

  /** Decrypts the stored pair. Sets `degraded` and returns null when it cannot. */
  private decrypt(row: ConnectorSettingsRecord): CredentialPair | null {
    if (!row.tokenCiphertext || !row.tokenNonce || !row.tokenTag) return null;
    if (!this.secretBox) {
      this.degraded = 'A Touchstream credential is stored but the master key is unavailable, so it cannot be used.';
      return null;
    }
    try {
      const plain = this.secretBox.open({ ciphertext: row.tokenCiphertext, nonce: row.tokenNonce, tag: row.tokenTag });
      const parsed = JSON.parse(plain) as CredentialPair;
      if (!parsed?.appId || !parsed?.token) {
        this.degraded = 'The stored Touchstream credential is incomplete; re-enter the app id and token.';
        return null;
      }
      this.degraded = null;
      return parsed;
    } catch {
      // Never log or echo the ciphertext.
      this.degraded = 'The stored Touchstream credential could not be decrypted with the current master key.';
      return null;
    }
  }

  private buildClient(eff: TouchstreamConfig): TouchstreamClient {
    if (eff.mode !== 'live') return new MockTouchstreamClient();
    return new HttpTouchstreamReadClient({ config: eff, logger: undefined, fetchImpl: this.fetchImpl });
  }

  private applyConfig(): void {
    const eff = this.effective();
    // Live mode without both credentials would poll straight into 403s; stay disabled and say why.
    const missing = eff.mode === 'live' && (!eff.endpoint || !eff.appId || !eff.token);
    if (missing && eff.enabled) {
      this.degraded =
        this.degraded ??
        'Touchstream live mode needs the API base plus BOTH credentials (the X-TS-ID app id and the bearer token) — either alone is refused.';
    }
    this.poller.reconfigure({
      client: this.buildClient(eff),
      source: eff.mode,
      enabled: eff.enabled && !missing,
      intervalMs: eff.pollIntervalSeconds * 1000,
      ownedPrefixes: eff.ownedPrefixes,
    });
  }

  view(): TouchstreamConnectionView {
    const eff = this.effective();
    return {
      connector: CONNECTOR,
      enabled: eff.enabled,
      mode: eff.mode,
      endpoint: eff.endpoint ?? null,
      environment: eff.environment,
      appIdConfigured: Boolean(eff.appId),
      tokenConfigured: Boolean(eff.token),
      credentialSetAt: this.persisted?.tokenSetAt?.toISOString() ?? null,
      updatedBy: this.persisted?.updatedBy ?? null,
      degraded: this.degraded,
      masterKeyAvailable: Boolean(this.secretBox),
    };
  }

  /** Persist a change. The credential pair is write-only: it is never returned by any route. */
  async updateSettings(input: TouchstreamConnectionInput, actor: string | null): Promise<TouchstreamConnectionView> {
    if (!this.repo) throw new TouchstreamError('Touchstream settings storage is unavailable.', 'TOUCHSTREAM_UNAVAILABLE');
    const current = this.persisted;
    const appId = (input.appId ?? '').trim();
    const token = (input.token ?? '').trim();
    // A masked placeholder means "unchanged" — never store the mask itself.
    const supplied = [appId, token].filter((v) => v.length > 0 && !MASKED.test(v));

    let credential: { action: 'retain' } | { action: 'replace'; value: string } | { action: 'clear' };
    if (input.clearCredentials) {
      credential = { action: 'clear' };
    } else if (supplied.length === 0) {
      credential = { action: 'retain' };
    } else if (supplied.length === 1) {
      // Half a credential is useless and would fail closed at the next poll; refuse it plainly.
      throw new TouchstreamError(
        'Supply BOTH the app id and the bearer token together — Touchstream refuses either one on its own.',
        'TOUCHSTREAM_AUTH',
      );
    } else {
      if (!this.secretBox) {
        throw new TouchstreamError(
          'A master key is required before a Touchstream credential can be stored (see docs/operations).',
          'TOUCHSTREAM_UNAVAILABLE',
        );
      }
      credential = { action: 'replace', value: JSON.stringify({ appId, token } satisfies CredentialPair) };
    }

    const sealed =
      credential.action === 'replace' && this.secretBox ? this.secretBox.seal(credential.value) : null;

    this.persisted = await this.repo.upsert({
      connector: CONNECTOR,
      enabled: input.enabled ?? current?.enabled ?? this.base.enabled,
      mode: input.mode ?? current?.mode ?? this.base.mode,
      endpoint: input.endpoint === undefined ? (current?.endpoint ?? this.base.endpoint ?? null) : input.endpoint,
      verifyTls: current?.verifyTls ?? true,
      edgeDeviceIds: input.environment ?? (current?.edgeDeviceIds ?? this.base.environment),
      updatedBy: actor,
      tokenAction: credential.action,
      ...(credential.action === 'replace' && sealed
        ? { tokenCiphertext: sealed.ciphertext, tokenNonce: sealed.nonce, tokenTag: sealed.tag }
        : {}),
    });

    if (credential.action !== 'retain') {
      // Audited without any secret material.
      await this.audit
        ?.record({
          action: credential.action === 'clear' ? 'connector.touchstream.credential.clear' : 'connector.touchstream.credential.replace',
          actorSubject: actor ?? undefined,
          resourceType: 'connector',
          resourceKey: CONNECTOR,
          outcome: 'success',
          // Deliberately no secret material — only that a credential changed.
          details: { connector: CONNECTOR },
        })
        .catch(() => undefined);
    }
    this.degraded = null;
    this.applyConfig();
    return this.view();
  }

  /** Read-only connectivity check: lists probe locations and reports how many came back. */
  async test(): Promise<{ ok: boolean; locationCount?: number; monitorCount?: number; error?: string; code?: string }> {
    const eff = this.effective();
    if (eff.mode === 'live' && (!eff.endpoint || !eff.appId || !eff.token)) {
      return { ok: false, error: 'The API base and BOTH credentials are required before testing.', code: 'TOUCHSTREAM_AUTH' };
    }
    try {
      const client = this.buildClient(eff);
      const [groups, streams] = await Promise.all([client.fetchLocationGroups(), client.fetchStreams()]);
      const locations = new Set(groups.flatMap((g) => (g?.locations ? Object.keys(g.locations) : [])));
      return { ok: true, locationCount: locations.size, monitorCount: streams.length };
    } catch (err) {
      if (err instanceof TouchstreamError) return { ok: false, error: err.message, code: err.code };
      return { ok: false, error: describe(err), code: 'TOUCHSTREAM_UNAVAILABLE' };
    }
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

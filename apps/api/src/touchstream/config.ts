// Touchstream connector configuration. READ-ONLY by construction: no field here can enable a write,
// and the HTTP client only ever issues GETs.
//
// Touchstream needs TWO credentials together (the spec declares them as a single AND requirement):
//   X-TS-ID: <app id>   +   Authorization: Bearer <token>
// Either alone returns 403. Both are sourced from a mounted secret first, then env, and are NEVER
// logged. Mock mode requires no credentials; live mode fails fast when either is missing.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type TouchstreamMode = 'mock' | 'live';

export interface TouchstreamConfig {
  enabled: boolean;
  mode: TouchstreamMode;
  /** API base, e.g. https://tsi.touchstream.global (no trailing slash). */
  endpoint?: string;
  /** X-TS-ID header value (live only). In memory only; never logged. */
  appId?: string;
  /** Bearer token (live only). In memory only; never logged. */
  token?: string;
  /** PROD or NPROD — scopes the windowed statistics/error-log calls. */
  environment: 'PROD' | 'NPROD';
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  retryAttempts: number;
  verifyTls: boolean;
  /** Age at which the snapshot is flagged stale on the page. */
  maxSampleAgeSeconds: number;
  /** RTÉ-owned prefixes, for edge-IP attribution. Config-driven precisely so RADAR never ships a
   *  guessed table of third-party CDN ranges — we only assert what we own. */
  ownedPrefixes: string[];
  /** Cap on error-log entries returned to the browser. */
  maxErrorEntries: number;
}

const APP_ID_SECRET = '/run/secrets/touchstream_app_id';
const TOKEN_SECRET = '/run/secrets/touchstream_token';

/** RTÉ / AS41073 prefixes — the same ones the bgp.tools connector monitors. */
export const DEFAULT_OWNED_PREFIXES = ['185.54.104.0/22', '89.207.56.0/21'];

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  TOUCHSTREAM_ENABLED: boolFrom(false),
  TOUCHSTREAM_MODE: z.enum(['mock', 'live']).default('mock'),
  TOUCHSTREAM_ENDPOINT: z.string().optional(),
  TOUCHSTREAM_APP_ID: z.string().optional(),
  TOUCHSTREAM_TOKEN: z.string().optional(),
  TOUCHSTREAM_ENVIRONMENT: z.enum(['PROD', 'NPROD']).default('PROD'),
  TOUCHSTREAM_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(20),
  TOUCHSTREAM_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().max(3600).default(60),
  TOUCHSTREAM_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(2),
  TOUCHSTREAM_VERIFY_TLS: boolFrom(true),
  TOUCHSTREAM_MAX_SAMPLE_AGE_SECONDS: z.coerce.number().int().positive().max(86400).default(600),
  TOUCHSTREAM_OWNED_PREFIXES: z.string().optional(),
  TOUCHSTREAM_MAX_ERROR_ENTRIES: z.coerce.number().int().positive().max(5000).default(500),
});

function readSecretFile(path: string): string | undefined {
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      return value.length > 0 ? value : undefined;
    }
  } catch {
    // Unreadable secret is treated as absent — fail closed, never crash the API.
  }
  return undefined;
}

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

/** Splits a comma/space separated list, dropping blanks. */
const listOf = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export class TouchstreamConfigError extends Error {}

export function loadTouchstreamConfig(env: NodeJS.ProcessEnv = process.env): TouchstreamConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TouchstreamConfigError(`Invalid Touchstream configuration: ${detail}`);
  }
  const p = parsed.data;
  const appId = readSecretFile(APP_ID_SECRET) ?? p.TOUCHSTREAM_APP_ID;
  const token = readSecretFile(TOKEN_SECRET) ?? p.TOUCHSTREAM_TOKEN;
  const prefixes = listOf(p.TOUCHSTREAM_OWNED_PREFIXES);

  const config: TouchstreamConfig = {
    enabled: p.TOUCHSTREAM_ENABLED,
    mode: p.TOUCHSTREAM_MODE,
    endpoint: p.TOUCHSTREAM_ENDPOINT ? stripTrailingSlash(p.TOUCHSTREAM_ENDPOINT) : undefined,
    appId,
    token,
    environment: p.TOUCHSTREAM_ENVIRONMENT,
    timeoutSeconds: p.TOUCHSTREAM_TIMEOUT_SECONDS,
    pollIntervalSeconds: p.TOUCHSTREAM_POLL_INTERVAL_SECONDS,
    retryAttempts: p.TOUCHSTREAM_RETRY_ATTEMPTS,
    verifyTls: p.TOUCHSTREAM_VERIFY_TLS,
    maxSampleAgeSeconds: p.TOUCHSTREAM_MAX_SAMPLE_AGE_SECONDS,
    ownedPrefixes: prefixes.length > 0 ? prefixes : DEFAULT_OWNED_PREFIXES,
    maxErrorEntries: p.TOUCHSTREAM_MAX_ERROR_ENTRIES,
  };

  // Live mode must not start half-configured and silently return nothing.
  if (config.enabled && config.mode === 'live') {
    const missing: string[] = [];
    if (!config.endpoint) missing.push('TOUCHSTREAM_ENDPOINT');
    if (!config.appId) missing.push('TOUCHSTREAM_APP_ID (or /run/secrets/touchstream_app_id)');
    if (!config.token) missing.push('TOUCHSTREAM_TOKEN (or /run/secrets/touchstream_token)');
    if (missing.length > 0) {
      throw new TouchstreamConfigError(
        `Touchstream live mode requires ${missing.join(', ')}. Touchstream needs BOTH the X-TS-ID app id and the bearer token — either alone is rejected with 403.`,
      );
    }
  }
  return config;
}

/** Redacted view, safe to log or return from a status route. */
export function describeTouchstreamConfig(c: TouchstreamConfig): Record<string, unknown> {
  return {
    enabled: c.enabled,
    mode: c.mode,
    endpoint: c.endpoint ?? null,
    environment: c.environment,
    appIdConfigured: Boolean(c.appId),
    tokenConfigured: Boolean(c.token),
    pollIntervalSeconds: c.pollIntervalSeconds,
    ownedPrefixes: c.ownedPrefixes,
  };
}

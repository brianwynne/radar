// Fastly connector configuration. READ-ONLY: no field can enable a write. The API token is
// sourced from a mounted secret first (/run/secrets/fastly_api_token) then FASTLY_API_TOKEN, and
// is NEVER logged. Mock mode requires no credentials; live mode fails fast and clearly when the
// token is missing. Mirrors the Cloudflare/CloudVision config idiom.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type FastlyMode = 'mock' | 'live';

export interface FastlyConfig {
  enabled: boolean;
  mode: FastlyMode;
  /** API token (live only). In memory only; never logged. */
  token?: string;
  /** Base URL of the Fastly API. */
  apiBase: string;
  /** Service ids to observe. Empty → observe all services on the account. */
  serviceIds: string[];
  /** Observation window (minutes) the per-service stats are aggregated over. */
  windowMinutes: number;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  /** Observations older than this are marked STALE. */
  maxSampleAgeSeconds: number;
  retryAttempts: number;
}

const TOKEN_SECRET = '/run/secrets/fastly_api_token';

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  FASTLY_ENABLED: boolFrom(false),
  FASTLY_MODE: z.enum(['mock', 'live']).default('mock'),
  FASTLY_API_TOKEN: z.string().optional(),
  FASTLY_API_BASE: z.string().default('https://api.fastly.com'),
  FASTLY_SERVICE_IDS: z.string().optional(),
  FASTLY_WINDOW_MINUTES: z.coerce.number().int().positive().min(1).max(60).default(10),
  FASTLY_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(15),
  FASTLY_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().max(3600).default(60),
  FASTLY_MAX_SAMPLE_AGE_SECONDS: z.coerce.number().int().positive().max(3600).default(180),
  FASTLY_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
});

function readSecretFile(path: string): string | undefined {
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      return value.length > 0 ? value : undefined;
    }
  } catch {
    // fall through to the env fallback
  }
  return undefined;
}

const csv = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

export function loadFastlyConfig(env: NodeJS.ProcessEnv = process.env): FastlyConfig {
  const p = schema.parse(env);
  const base: FastlyConfig = {
    enabled: p.FASTLY_ENABLED,
    mode: p.FASTLY_MODE,
    apiBase: p.FASTLY_API_BASE.replace(/\/+$/, ''),
    serviceIds: csv(p.FASTLY_SERVICE_IDS),
    windowMinutes: p.FASTLY_WINDOW_MINUTES,
    timeoutSeconds: p.FASTLY_TIMEOUT_SECONDS,
    pollIntervalSeconds: p.FASTLY_POLL_INTERVAL_SECONDS,
    maxSampleAgeSeconds: p.FASTLY_MAX_SAMPLE_AGE_SECONDS,
    retryAttempts: p.FASTLY_RETRY_ATTEMPTS,
  };
  if (!p.FASTLY_ENABLED || p.FASTLY_MODE !== 'live') return base;

  // Live mode: a read-only API token (secret first) is required.
  const token = readSecretFile(TOKEN_SECRET) ?? p.FASTLY_API_TOKEN;
  if (!token) throw new Error('Fastly configuration: live mode requires an API token (/run/secrets/fastly_api_token or FASTLY_API_TOKEN).');
  return { ...base, token };
}

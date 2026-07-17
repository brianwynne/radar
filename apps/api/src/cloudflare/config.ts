// Cloudflare connector configuration. READ-ONLY: no field can enable a write. The API token is
// sourced from a mounted secret first (/run/secrets/cloudflare_api_token) then CLOUDFLARE_API_TOKEN,
// and is NEVER logged. Mock mode requires no credentials; live mode fails fast and clearly when
// the account id or token is missing. Mirrors the CloudVision/telemetry config idiom.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type CloudflareMode = 'mock' | 'live';

export interface CloudflareConfig {
  enabled: boolean;
  mode: CloudflareMode;
  /** Cloudflare account id (live only). */
  accountId?: string;
  /** API token (live only). In memory only; never logged. */
  token?: string;
  /** Base URL of the Cloudflare API. */
  apiBase: string;
  /** Zone names whose load balancers to read. Empty → auto-discover (all non-reverse-DNS zones). */
  lbZones: string[];
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  /** Observations older than this are marked STALE. */
  maxSampleAgeSeconds: number;
  retryAttempts: number;
}

const TOKEN_SECRET = '/run/secrets/cloudflare_api_token';

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  CLOUDFLARE_ENABLED: boolFrom(false),
  CLOUDFLARE_MODE: z.enum(['mock', 'live']).default('mock'),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_API_BASE: z.string().default('https://api.cloudflare.com/client/v4'),
  CLOUDFLARE_LB_ZONES: z.string().optional(),
  CLOUDFLARE_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(15),
  CLOUDFLARE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().max(3600).default(30),
  CLOUDFLARE_MAX_SAMPLE_AGE_SECONDS: z.coerce.number().int().positive().max(3600).default(180),
  CLOUDFLARE_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
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

export function loadCloudflareConfig(env: NodeJS.ProcessEnv = process.env): CloudflareConfig {
  const p = schema.parse(env);
  const base: CloudflareConfig = {
    enabled: p.CLOUDFLARE_ENABLED,
    mode: p.CLOUDFLARE_MODE,
    apiBase: p.CLOUDFLARE_API_BASE.replace(/\/+$/, ''),
    lbZones: csv(p.CLOUDFLARE_LB_ZONES),
    timeoutSeconds: p.CLOUDFLARE_TIMEOUT_SECONDS,
    pollIntervalSeconds: p.CLOUDFLARE_POLL_INTERVAL_SECONDS,
    maxSampleAgeSeconds: p.CLOUDFLARE_MAX_SAMPLE_AGE_SECONDS,
    retryAttempts: p.CLOUDFLARE_RETRY_ATTEMPTS,
  };
  if (!p.CLOUDFLARE_ENABLED || p.CLOUDFLARE_MODE !== 'live') return base;

  // Live mode: token (secret first) + account id are required.
  const token = readSecretFile(TOKEN_SECRET) ?? p.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Cloudflare configuration: live mode requires an API token (/run/secrets/cloudflare_api_token or CLOUDFLARE_API_TOKEN).');
  if (!p.CLOUDFLARE_ACCOUNT_ID) throw new Error('Cloudflare configuration: live mode requires CLOUDFLARE_ACCOUNT_ID.');
  return { ...base, token, accountId: p.CLOUDFLARE_ACCOUNT_ID };
}

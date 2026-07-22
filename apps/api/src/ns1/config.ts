// NS1 Connect client configuration. RADAR v1 is READ-ONLY to NS1 (docs/ns1/developer-
// guide.md §2): GET-only, no write-capable credential, no generic proxy. The API key
// lives only in radar-api and is NEVER logged.
//
// Two modes:
//   mock — fixture-backed adapter, no NS1 credential required (default for dev/tests).
//   live — real NS1 Connect over HTTPS with a dedicated read-only X-NSONE-Key.
//
// Secret precedence (guide §22): /run/secrets/ns1_api_key first (container secret), then
// the NS1_API_KEY env var (development only).
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type RadarMode = 'mock' | 'live';

export interface Ns1Config {
  mode: RadarMode;
  /** Base URL without a trailing slash, e.g. https://api.nsone.net/v1. */
  baseUrl: string;
  /** Present in live mode; undefined in mock mode. Never logged. */
  apiKey?: string;
  requestTimeoutMs: number;
  maxRetries: number;
  cacheTtlSeconds: number;
  /** RADAR v1 is read-only; this ENABLES the guarded create-record path. Default OFF — even a
   *  write-capable key can't write until this is explicitly turned on. */
  writeEnabled: boolean;
  /** Allow-list of record names that MAY be created (exact, or a `*.suffix` wildcard). A create is
   *  blocked unless its domain matches one of these — so a slip can't touch live records. */
  writeAllow: string[];
  /** Optional dedicated write key (secret first, then env); falls back to `apiKey`. Never logged. */
  writeApiKey?: string;
}

const SECRET_FILE = '/run/secrets/ns1_api_key';
const WRITE_SECRET_FILE = '/run/secrets/ns1_write_api_key';
// Safe default namespace: only the nominated test zone can ever be created out of the box.
const DEFAULT_WRITE_ALLOW = ['livetest.rte.ie', '*.livetest.rte.ie'];

const schema = z.object({
  RADAR_MODE: z.enum(['mock', 'live']).default('mock'),
  NS1_API_BASE: z.string().default('https://api.nsone.net/v1'),
  NS1_API_KEY: z.string().optional(),
  NS1_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NS1_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  NS1_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(30),
  NS1_WRITE_ENABLED: z.preprocess((v) => (v === undefined ? false : /^(1|true|yes|on)$/i.test(String(v))), z.boolean()),
  NS1_WRITE_ALLOW: z.string().optional(),
  NS1_WRITE_API_KEY: z.string().optional(),
});

function readSecretAt(path: string): string | undefined {
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      return value.length > 0 ? value : undefined;
    }
  } catch {
    // Unreadable secret file is treated as absent; live mode will then fail fast below.
  }
  return undefined;
}
function readSecretFile(): string | undefined {
  return readSecretAt(SECRET_FILE);
}

export function loadNs1Config(env: NodeJS.ProcessEnv = process.env): Ns1Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid NS1 configuration: ${detail}`);
  }
  const p = parsed.data;
  const baseUrl = p.NS1_API_BASE.replace(/\/+$/, '');
  const envKey = p.NS1_API_KEY?.trim();
  const apiKey = readSecretFile() ?? (envKey && envKey.length > 0 ? envKey : undefined);

  if (p.RADAR_MODE === 'live') {
    if (!/^https:\/\//i.test(baseUrl)) {
      throw new Error('NS1 configuration: NS1_API_BASE must use HTTPS in live mode.');
    }
    if (!apiKey) {
      throw new Error(
        'NS1 configuration: live mode requires a read-only NS1 API key via /run/secrets/ns1_api_key or NS1_API_KEY.',
      );
    }
  }

  // Parse the write allow-list (comma- or whitespace-separated), lower-cased; fall back to the safe
  // default test namespace. Only these names may ever be created.
  const writeAllow = (p.NS1_WRITE_ALLOW ?? '')
    .split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  // The write path requires a DEDICATED write key — it deliberately does NOT fall back to the read
  // key. A read-only credential must never satisfy the writer's "key configured" guard, so with no
  // write key provisioned the NS1 write path stays inert (writeReady() → false) regardless of the gate.
  const writeApiKey = readSecretAt(WRITE_SECRET_FILE) ?? p.NS1_WRITE_API_KEY?.trim();

  return {
    mode: p.RADAR_MODE,
    baseUrl,
    apiKey,
    requestTimeoutMs: p.NS1_REQUEST_TIMEOUT_MS,
    maxRetries: p.NS1_MAX_RETRIES,
    cacheTtlSeconds: p.NS1_CACHE_TTL_SECONDS,
    writeEnabled: p.NS1_WRITE_ENABLED,
    writeAllow: writeAllow.length ? writeAllow : DEFAULT_WRITE_ALLOW,
    writeApiKey: writeApiKey && writeApiKey.length ? writeApiKey : undefined,
  };
}

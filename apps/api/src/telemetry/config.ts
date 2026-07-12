// Network-path telemetry configuration. Telemetry is READ-ONLY and INFORMATIONAL. Three
// modes: disabled (default — utilisation shown as "not connected"), mock (deterministic
// synthetic data), prometheus (real read-only instant queries). Prometheus authentication
// is GENERIC (optional bearer or basic from a mounted secret) — no cloud-specific SDK, and
// credentials are NEVER logged. Browser input never contributes to a query.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type TelemetryMode = 'disabled' | 'mock' | 'prometheus';

export interface PrometheusAuth {
  kind: 'none' | 'bearer' | 'basic';
  /** Present for bearer; never logged. */
  bearerToken?: string;
  /** Present for basic; never logged. */
  basicAuth?: string; // "user:password" (pre-encoded to base64 at request time)
}

export interface TelemetryConfig {
  mode: TelemetryMode;
  staleAfterSeconds: number;
  cacheTtlSeconds: number;
  /** Global threshold overrides applied to the central path mappings. */
  warningPercent?: number;
  criticalPercent?: number;
  prometheus?: {
    baseUrl: string;
    requestTimeoutMs: number;
    maxRetries: number;
    /** Instant-query template; may contain `$INTERFACE` and `$DIRECTION` placeholders that
     *  RADAR substitutes from the central path mapping (server-side only). */
    queryPathUtilisation: string;
    auth: PrometheusAuth;
  };
}

const BEARER_SECRET = '/run/secrets/prometheus_bearer_token';
const BASIC_SECRET = '/run/secrets/prometheus_basic_auth';

const schema = z.object({
  NETWORK_TELEMETRY_MODE: z.enum(['disabled', 'mock', 'prometheus']).default('disabled'),
  NETWORK_TELEMETRY_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(120),
  NETWORK_TELEMETRY_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(15),
  NETWORK_TELEMETRY_WARNING_PERCENT: z.coerce.number().min(0).max(100).optional(),
  NETWORK_TELEMETRY_CRITICAL_PERCENT: z.coerce.number().min(0).max(100).optional(),
  PROMETHEUS_BASE_URL: z.string().optional(),
  PROMETHEUS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  PROMETHEUS_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  PROMETHEUS_QUERY_PATH_UTILISATION: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function readSecretFile(path: string): string | undefined {
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      return value.length > 0 ? value : undefined;
    }
  } catch {
    // Unreadable secret is treated as absent.
  }
  return undefined;
}

/** Bearer/basic Prometheus auth, sourced only from mounted secrets (never env, never logged).
 *  Shared by network-path and cache/origin telemetry (a single Prometheus). */
export function loadPrometheusAuth(): PrometheusAuth {
  const bearer = readSecretFile(BEARER_SECRET);
  if (bearer) return { kind: 'bearer', bearerToken: bearer };
  const basic = readSecretFile(BASIC_SECRET);
  if (basic) return { kind: 'basic', basicAuth: basic };
  return { kind: 'none' };
}

export function loadTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid network-telemetry configuration: ${detail}`);
  }
  const p = parsed.data;

  if (p.NETWORK_TELEMETRY_WARNING_PERCENT !== undefined && p.NETWORK_TELEMETRY_CRITICAL_PERCENT !== undefined && p.NETWORK_TELEMETRY_CRITICAL_PERCENT < p.NETWORK_TELEMETRY_WARNING_PERCENT) {
    throw new Error('Network-telemetry configuration: NETWORK_TELEMETRY_CRITICAL_PERCENT must be ≥ NETWORK_TELEMETRY_WARNING_PERCENT.');
  }

  const base: TelemetryConfig = {
    mode: p.NETWORK_TELEMETRY_MODE,
    staleAfterSeconds: p.NETWORK_TELEMETRY_STALE_AFTER_SECONDS,
    cacheTtlSeconds: p.NETWORK_TELEMETRY_CACHE_TTL_SECONDS,
    warningPercent: p.NETWORK_TELEMETRY_WARNING_PERCENT,
    criticalPercent: p.NETWORK_TELEMETRY_CRITICAL_PERCENT,
  };

  if (p.NETWORK_TELEMETRY_MODE !== 'prometheus') return base;

  const baseUrl = (p.PROMETHEUS_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Network-telemetry configuration: prometheus mode requires PROMETHEUS_BASE_URL.');
  if (!p.PROMETHEUS_QUERY_PATH_UTILISATION) throw new Error('Network-telemetry configuration: prometheus mode requires PROMETHEUS_QUERY_PATH_UTILISATION.');
  // HTTPS is required outside development (a plain-HTTP source could leak the bearer token).
  if (p.NODE_ENV !== 'development' && !/^https:\/\//i.test(baseUrl)) {
    throw new Error('Network-telemetry configuration: PROMETHEUS_BASE_URL must use HTTPS outside development.');
  }

  return {
    ...base,
    prometheus: {
      baseUrl,
      requestTimeoutMs: p.PROMETHEUS_REQUEST_TIMEOUT_MS,
      maxRetries: p.PROMETHEUS_MAX_RETRIES,
      queryPathUtilisation: p.PROMETHEUS_QUERY_PATH_UTILISATION,
      auth: loadPrometheusAuth(),
    },
  };
}

// Cache/origin telemetry configuration. READ-ONLY and INFORMATIONAL. Mirrors the network-
// telemetry config: disabled (default) / mock / prometheus. Reuses the same single Prometheus
// connection (base URL + timeout + retries) and the same GENERIC auth from a mounted secret
// (never env, never logged). Query templates are RADAR-owned; `$POOL`/`$NODE` are substituted
// server-side only — browser input never contributes to a query.
import { z } from 'zod';
import { loadPrometheusAuth, type PrometheusAuth, type TelemetryMode } from './config.js';

/** RADAR-owned instant-query templates. All optional; a missing template means that metric is
 *  simply not observed (rendered as unavailable), never fabricated. */
export interface CacheQueryTemplates {
  poolThroughput?: string; // `$POOL`
  poolCpu?: string;
  poolMemory?: string;
  poolHitRatio?: string;
  poolRequestRate?: string;
  nodeThroughput?: string; // `$NODE`
  nodeCpu?: string;
  nodeMemory?: string;
  nodeHitRatio?: string;
  nodeRequestRate?: string;
  originRequestRate?: string;
  originBandwidth?: string;
  originCpu?: string;
}

export interface CacheTelemetryConfig {
  mode: TelemetryMode;
  staleAfterSeconds: number;
  cacheTtlSeconds: number;
  warningPercent?: number;
  criticalPercent?: number;
  prometheus?: {
    baseUrl: string;
    requestTimeoutMs: number;
    maxRetries: number;
    auth: PrometheusAuth;
    queries: CacheQueryTemplates;
  };
}

const schema = z.object({
  CACHE_TELEMETRY_MODE: z.enum(['disabled', 'mock', 'prometheus']).default('disabled'),
  CACHE_TELEMETRY_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(120),
  CACHE_TELEMETRY_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(15),
  CACHE_TELEMETRY_WARNING_PERCENT: z.coerce.number().min(0).max(100).optional(),
  CACHE_TELEMETRY_CRITICAL_PERCENT: z.coerce.number().min(0).max(100).optional(),
  // Reuses the same Prometheus connection as the network-path telemetry.
  PROMETHEUS_BASE_URL: z.string().optional(),
  PROMETHEUS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  PROMETHEUS_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  PROMETHEUS_QUERY_POOL_THROUGHPUT: z.string().optional(),
  PROMETHEUS_QUERY_POOL_CPU: z.string().optional(),
  PROMETHEUS_QUERY_POOL_MEMORY: z.string().optional(),
  PROMETHEUS_QUERY_POOL_HIT_RATIO: z.string().optional(),
  PROMETHEUS_QUERY_POOL_REQUEST_RATE: z.string().optional(),
  PROMETHEUS_QUERY_NODE_THROUGHPUT: z.string().optional(),
  PROMETHEUS_QUERY_NODE_CPU: z.string().optional(),
  PROMETHEUS_QUERY_NODE_MEMORY: z.string().optional(),
  PROMETHEUS_QUERY_NODE_HIT_RATIO: z.string().optional(),
  PROMETHEUS_QUERY_NODE_REQUEST_RATE: z.string().optional(),
  PROMETHEUS_QUERY_ORIGIN_REQUEST_RATE: z.string().optional(),
  PROMETHEUS_QUERY_ORIGIN_BANDWIDTH: z.string().optional(),
  PROMETHEUS_QUERY_ORIGIN_CPU: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export function loadCacheTelemetryConfig(env: NodeJS.ProcessEnv = process.env): CacheTelemetryConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid cache-telemetry configuration: ${detail}`);
  }
  const p = parsed.data;

  if (p.CACHE_TELEMETRY_WARNING_PERCENT !== undefined && p.CACHE_TELEMETRY_CRITICAL_PERCENT !== undefined && p.CACHE_TELEMETRY_CRITICAL_PERCENT < p.CACHE_TELEMETRY_WARNING_PERCENT) {
    throw new Error('Cache-telemetry configuration: CACHE_TELEMETRY_CRITICAL_PERCENT must be ≥ CACHE_TELEMETRY_WARNING_PERCENT.');
  }

  const base: CacheTelemetryConfig = {
    mode: p.CACHE_TELEMETRY_MODE,
    staleAfterSeconds: p.CACHE_TELEMETRY_STALE_AFTER_SECONDS,
    cacheTtlSeconds: p.CACHE_TELEMETRY_CACHE_TTL_SECONDS,
    warningPercent: p.CACHE_TELEMETRY_WARNING_PERCENT,
    criticalPercent: p.CACHE_TELEMETRY_CRITICAL_PERCENT,
  };

  if (p.CACHE_TELEMETRY_MODE !== 'prometheus') return base;

  const baseUrl = (p.PROMETHEUS_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Cache-telemetry configuration: prometheus mode requires PROMETHEUS_BASE_URL.');
  if (!p.PROMETHEUS_QUERY_POOL_THROUGHPUT) throw new Error('Cache-telemetry configuration: prometheus mode requires at least PROMETHEUS_QUERY_POOL_THROUGHPUT.');
  if (p.NODE_ENV !== 'development' && !/^https:\/\//i.test(baseUrl)) {
    throw new Error('Cache-telemetry configuration: PROMETHEUS_BASE_URL must use HTTPS outside development.');
  }

  return {
    ...base,
    prometheus: {
      baseUrl,
      requestTimeoutMs: p.PROMETHEUS_REQUEST_TIMEOUT_MS,
      maxRetries: p.PROMETHEUS_MAX_RETRIES,
      auth: loadPrometheusAuth(),
      queries: {
        poolThroughput: p.PROMETHEUS_QUERY_POOL_THROUGHPUT,
        poolCpu: p.PROMETHEUS_QUERY_POOL_CPU,
        poolMemory: p.PROMETHEUS_QUERY_POOL_MEMORY,
        poolHitRatio: p.PROMETHEUS_QUERY_POOL_HIT_RATIO,
        poolRequestRate: p.PROMETHEUS_QUERY_POOL_REQUEST_RATE,
        nodeThroughput: p.PROMETHEUS_QUERY_NODE_THROUGHPUT,
        nodeCpu: p.PROMETHEUS_QUERY_NODE_CPU,
        nodeMemory: p.PROMETHEUS_QUERY_NODE_MEMORY,
        nodeHitRatio: p.PROMETHEUS_QUERY_NODE_HIT_RATIO,
        nodeRequestRate: p.PROMETHEUS_QUERY_NODE_REQUEST_RATE,
        originRequestRate: p.PROMETHEUS_QUERY_ORIGIN_REQUEST_RATE,
        originBandwidth: p.PROMETHEUS_QUERY_ORIGIN_BANDWIDTH,
        originCpu: p.PROMETHEUS_QUERY_ORIGIN_CPU,
      },
    },
  };
}

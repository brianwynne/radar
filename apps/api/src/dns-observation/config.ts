// DNS-observation configuration. Tier-2 active probing is READ-ONLY and OFF by default.
// Modes: disabled (default), mock (deterministic), resolver (real UDP DNS to configured
// resolvers). Optional periodic observation is disabled by default with a bounded minimum
// interval, bounded concurrency, exponential backoff and per-ISP failure isolation — no
// aggressive probing.
import { z } from 'zod';

export type DnsObservationMode = 'disabled' | 'mock' | 'resolver';

export interface DnsObservationConfig {
  mode: DnsObservationMode;
  /** Per-query timeout. */
  timeoutMs: number;
  /** Freshness window: an observation older than this is considered stale in the UI. */
  staleAfterSeconds: number;
  /** Periodic observation (off by default). */
  periodic: {
    enabled: boolean;
    /** Minimum interval between automatic observation cycles (clamped floor). */
    minIntervalSeconds: number;
    /** Max ISPs observed concurrently. */
    concurrency: number;
    /** Max backoff between failing cycles. */
    maxBackoffSeconds: number;
  };
}

const MIN_INTERVAL_FLOOR = 60; // never probe more often than once a minute per automatic cycle

const schema = z.object({
  DNS_OBSERVATION_MODE: z.enum(['disabled', 'mock', 'resolver']).default('disabled'),
  DNS_OBSERVATION_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(3000),
  DNS_OBSERVATION_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(900),
  DNS_OBSERVATION_PERIODIC_ENABLED: z.string().optional(),
  DNS_OBSERVATION_INTERVAL_SECONDS: z.coerce.number().int().positive().default(900),
  DNS_OBSERVATION_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  DNS_OBSERVATION_MAX_BACKOFF_SECONDS: z.coerce.number().int().positive().default(3600),
});

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function loadDnsObservationConfig(env: NodeJS.ProcessEnv = process.env): DnsObservationConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid DNS-observation configuration: ${detail}`);
  }
  const p = parsed.data;
  return {
    mode: p.DNS_OBSERVATION_MODE,
    timeoutMs: p.DNS_OBSERVATION_TIMEOUT_MS,
    staleAfterSeconds: p.DNS_OBSERVATION_STALE_AFTER_SECONDS,
    periodic: {
      enabled: p.DNS_OBSERVATION_PERIODIC_ENABLED !== undefined && TRUTHY.has(p.DNS_OBSERVATION_PERIODIC_ENABLED.toLowerCase()),
      // Enforce a floor so misconfiguration can never cause aggressive probing.
      minIntervalSeconds: Math.max(MIN_INTERVAL_FLOOR, p.DNS_OBSERVATION_INTERVAL_SECONDS),
      concurrency: p.DNS_OBSERVATION_CONCURRENCY,
      maxBackoffSeconds: p.DNS_OBSERVATION_MAX_BACKOFF_SECONDS,
    },
  };
}

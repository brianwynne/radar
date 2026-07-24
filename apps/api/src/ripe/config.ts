// RIPE BGP intelligence configuration. All read-only public APIs — no credentials, no secrets.
// Defaults monitor AS41073's initial prefix set; a deployment overrides via env. Mirrors the other
// connector config idioms (env-parsed, zod-validated, safe defaults).
import { z } from 'zod';
import { DEFAULT_ASSESS, type AssessConfig } from './adapter.js';
import { MONITORED_PREFIXES } from './fixtures.js';

export interface RipeMonitoredPrefix { prefix: string; expectedOrigin: number }

export interface RipeConfig {
  enabled: boolean;
  monitoredPrefixes: RipeMonitoredPrefix[];
  pollIntervalSeconds: number;
  assess: AssessConfig;
  risLiveEnabled: boolean;
  timeoutSeconds: number;
  userAgent: string;
  cacheTtlSeconds: number;
}

const boolFrom = (def: boolean) => z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  RIPE_ENABLED: boolFrom(false),
  RIPE_RIS_LIVE_ENABLED: boolFrom(true),
  RIPE_MONITORED_FILE: z.string().optional(),
  RIPE_MONITORED_PREFIXES: z.string().optional(), // JSON [{prefix,expectedOrigin}] override
  RIPE_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300), // 5 min default
  RIPE_VISIBILITY_HEALTHY_PERCENT: z.coerce.number().min(0).max(100).default(DEFAULT_ASSESS.visibilityHealthyPercent),
  RIPE_VISIBILITY_DEGRADED_PERCENT: z.coerce.number().min(0).max(100).default(DEFAULT_ASSESS.visibilityDegradedPercent),
  RIPE_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(86400).default(DEFAULT_ASSESS.maxAgeSeconds),
  RIPE_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(60).default(8),
  RIPE_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  RIPE_USER_AGENT: z.string().optional(),
});

const monitoredSchema = z.array(z.object({ prefix: z.string().min(1), expectedOrigin: z.number().int().positive() }));

function loadMonitored(json: string | undefined): RipeMonitoredPrefix[] {
  if (!json) return MONITORED_PREFIXES;
  return monitoredSchema.parse(JSON.parse(json));
}

export function loadRipeConfig(env: NodeJS.ProcessEnv = process.env): RipeConfig {
  const p = schema.parse(env);
  const healthy = p.RIPE_VISIBILITY_HEALTHY_PERCENT;
  const degraded = p.RIPE_VISIBILITY_DEGRADED_PERCENT;
  if (degraded > healthy) throw new Error('RIPE_VISIBILITY_DEGRADED_PERCENT must be <= RIPE_VISIBILITY_HEALTHY_PERCENT.');
  return {
    enabled: p.RIPE_ENABLED,
    monitoredPrefixes: loadMonitored(p.RIPE_MONITORED_PREFIXES),
    pollIntervalSeconds: p.RIPE_POLL_INTERVAL_SECONDS,
    assess: { visibilityHealthyPercent: healthy, visibilityDegradedPercent: degraded, maxAgeSeconds: p.RIPE_MAX_AGE_SECONDS },
    risLiveEnabled: p.RIPE_RIS_LIVE_ENABLED,
    timeoutSeconds: p.RIPE_TIMEOUT_SECONDS,
    userAgent: p.RIPE_USER_AGENT ?? 'RADAR/bgp-intelligence (+https://radar.rtegroup.ie)',
    cacheTtlSeconds: p.RIPE_CACHE_TTL_SECONDS,
  };
}

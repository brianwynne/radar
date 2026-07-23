// bgp.tools connector configuration. READ-ONLY: no field can enable a write to BGP or NS1. The
// optional API token is sourced from a mounted secret first (/run/secrets/bgptools_token) then
// BGPTOOLS_TOKEN, held in memory only, never logged. Mock mode needs no credentials; live mode
// requires a documented, identifying User-Agent (bgp.tools blocks default/generic agents). Mirrors
// the CloudVision config idiom.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS, type AssessmentThresholds } from './adapter.js';
import { MOCK_MONITORED_PREFIXES } from './fixtures.js';
import type { AddressFamily, MonitoredPrefix } from './types.js';

export type BgpToolsMode = 'mock' | 'live';

export interface BgpToolsConfig {
  enabled: boolean;
  mode: BgpToolsMode;
  /** Documented table-dump endpoint (live only). Default is the public JSONL table. */
  tableUrl: string;
  /** Identifying User-Agent, "appname bgp.tools - contact@email" (bgp.tools blocks generic agents). */
  userAgent: string;
  /** Optional API token (live only). In memory only; never logged or returned to the browser. */
  token?: string;
  /** Prefixes RADAR watches, each with an expected origin ASN. */
  monitoredPrefixes: MonitoredPrefix[];
  /** Visibility hits representing full/global visibility (the table's collector-session count). */
  fullVisibilityHits: number;
  thresholds: AssessmentThresholds;
  /** Poll interval — default 30 min, honouring the table's "don't fetch more often than 30 min". */
  pollIntervalSeconds: number;
  /** Raw-observation retention (days). */
  retentionDays: number;
  timeoutSeconds: number;
  verifyTls: boolean;
  /** Dev-only mock scenario name (ignored in live mode). */
  mockScenario?: string;
}

const TOKEN_SECRET = '/run/secrets/bgptools_token';
const DEFAULT_TABLE_URL = 'https://bgp.tools/table.jsonl';

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  BGPTOOLS_ENABLED: boolFrom(false),
  BGPTOOLS_MODE: z.enum(['mock', 'live']).default('mock'),
  BGPTOOLS_TABLE_URL: z.string().url().default(DEFAULT_TABLE_URL),
  BGPTOOLS_USER_AGENT: z.string().optional(),
  BGPTOOLS_TOKEN: z.string().optional(),
  BGPTOOLS_MONITORED_FILE: z.string().optional(),
  BGPTOOLS_FULL_VISIBILITY_HITS: z.coerce.number().int().positive().max(100000).default(100),
  BGPTOOLS_VISIBILITY_WARN_RATIO: z.coerce.number().min(0).max(1).default(DEFAULT_THRESHOLDS.visibilityWarnRatio),
  BGPTOOLS_VISIBILITY_CRITICAL_RATIO: z.coerce.number().min(0).max(1).default(DEFAULT_THRESHOLDS.visibilityCriticalRatio),
  BGPTOOLS_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(86400).default(DEFAULT_THRESHOLDS.maxAgeSeconds),
  BGPTOOLS_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1800).max(86400).default(1800),
  BGPTOOLS_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),
  BGPTOOLS_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(30),
  BGPTOOLS_VERIFY_TLS: boolFrom(true),
  BGPTOOLS_MOCK_SCENARIO: z.string().optional(),
});

function readSecretFile(path: string): string | undefined {
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      return value.length > 0 ? value : undefined;
    }
  } catch {
    // unreadable secret file → treat as absent (fails closed in live mode)
  }
  return undefined;
}

const monitoredSchema = z.array(
  z.object({
    prefix: z.string().min(1),
    addressFamily: z.enum(['ipv4', 'ipv6']),
    expectedOriginAsn: z.number().int().positive(),
    description: z.string().optional(),
  }),
);

/** Load and validate the monitored-prefix list from a JSON file, if provided. */
function loadMonitored(path: string | undefined, mode: BgpToolsMode): MonitoredPrefix[] {
  if (!path) return mode === 'mock' ? MOCK_MONITORED_PREFIXES : [];
  const parsed = monitoredSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.map((p) => ({ ...p, addressFamily: p.addressFamily as AddressFamily }));
}

export function loadBgpToolsConfig(env: NodeJS.ProcessEnv = process.env): BgpToolsConfig {
  const p = schema.parse(env);
  const token = readSecretFile(TOKEN_SECRET) ?? p.BGPTOOLS_TOKEN;
  const base: BgpToolsConfig = {
    enabled: p.BGPTOOLS_ENABLED,
    mode: p.BGPTOOLS_MODE,
    tableUrl: p.BGPTOOLS_TABLE_URL,
    userAgent: p.BGPTOOLS_USER_AGENT ?? '',
    token,
    monitoredPrefixes: loadMonitored(p.BGPTOOLS_MONITORED_FILE, p.BGPTOOLS_MODE),
    fullVisibilityHits: p.BGPTOOLS_FULL_VISIBILITY_HITS,
    thresholds: {
      visibilityWarnRatio: p.BGPTOOLS_VISIBILITY_WARN_RATIO,
      visibilityCriticalRatio: p.BGPTOOLS_VISIBILITY_CRITICAL_RATIO,
      maxAgeSeconds: p.BGPTOOLS_MAX_AGE_SECONDS,
    },
    pollIntervalSeconds: p.BGPTOOLS_POLL_INTERVAL_SECONDS,
    retentionDays: p.BGPTOOLS_RETENTION_DAYS,
    timeoutSeconds: p.BGPTOOLS_TIMEOUT_SECONDS,
    verifyTls: p.BGPTOOLS_VERIFY_TLS,
    mockScenario: p.BGPTOOLS_MOCK_SCENARIO,
  };

  // The warn ratio must sit above the critical ratio for a coherent two-tier assessment.
  if (base.thresholds.visibilityWarnRatio < base.thresholds.visibilityCriticalRatio) {
    throw new Error('BGPTOOLS_VISIBILITY_WARN_RATIO must be >= BGPTOOLS_VISIBILITY_CRITICAL_RATIO.');
  }
  // Disabled or mock: no credentials or identifying UA required.
  if (!base.enabled || base.mode === 'mock') return base;

  // Live: bgp.tools blocks default/generic User-Agents — require an identifying one with contact.
  if (!base.userAgent || !/\S+@\S+/.test(base.userAgent)) {
    throw new Error('BGPTOOLS_USER_AGENT must be set to an identifying value including a contact email for live mode (bgp.tools blocks generic agents).');
  }
  return base;
}

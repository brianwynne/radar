// CloudVision connector configuration. READ-ONLY: no field can enable a write. The service-
// account token is sourced from a mounted secret first (/run/secrets/cloudvision_token) then
// CLOUDVISION_TOKEN, and is NEVER logged. Mock mode requires no credentials; live mode fails
// fast and clearly when the endpoint or token is missing. Mirrors the telemetry config idiom.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { validateClassificationRules, type ClassificationRule } from './classification.js';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from './classification-rules.js';

export type CloudVisionMode = 'mock' | 'live';

export interface CloudVisionConfig {
  /** Whether the connector runs at all. When false the source is `disabled`. */
  enabled: boolean;
  mode: CloudVisionMode;
  /** CloudVision base URL (live only). */
  endpoint?: string;
  /** Service-account token (live only). Present in memory only; never logged. */
  token?: string;
  /** Configured edge device ids (serials) to discover/expect. */
  edgeDeviceIds: string[];
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  verifyTls: boolean;
  maxSampleAgeSeconds: number;
  retryAttempts: number;
  warningPercent: number;
  criticalPercent: number;
  primaryDirection: 'inbound' | 'outbound';
  classificationRules: ClassificationRule[];
  providerForAsn: Record<number, string>;
}

const TOKEN_SECRET = '/run/secrets/cloudvision_token';

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  CLOUDVISION_ENABLED: boolFrom(false),
  CLOUDVISION_MODE: z.enum(['mock', 'live']).default('mock'),
  CLOUDVISION_ENDPOINT: z.string().optional(),
  CLOUDVISION_TOKEN: z.string().optional(),
  CLOUDVISION_EDGE_DEVICE_IDS: z.string().optional(),
  CLOUDVISION_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(10),
  CLOUDVISION_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().max(3600).default(10),
  CLOUDVISION_VERIFY_TLS: boolFrom(true),
  CLOUDVISION_MAX_SAMPLE_AGE_SECONDS: z.coerce.number().int().positive().max(3600).default(30),
  CLOUDVISION_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  CLOUDVISION_WARNING_PERCENT: z.coerce.number().min(0).max(100).default(80),
  CLOUDVISION_CRITICAL_PERCENT: z.coerce.number().min(0).max(100).default(90),
  CLOUDVISION_PRIMARY_DIRECTION: z.enum(['inbound', 'outbound']).default('outbound'),
  CLOUDVISION_CLASSIFICATION_FILE: z.string().optional(),
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

const ruleSchema = z.object({
  match: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('device_interface'), deviceId: z.string(), interface: z.string() }),
    z.object({ kind: z.literal('description_exact'), description: z.string() }),
    z.object({ kind: z.literal('description_regex'), pattern: z.string(), flags: z.string().optional() }),
  ]),
  linkType: z.enum(['PRIVATE_PEERING', 'IX_PEERING', 'TRANSIT', 'INTERNAL', 'UNKNOWN']),
  provider: z.string().optional(),
  location: z.string().optional(),
});
const classificationFileSchema = z.object({
  rules: z.array(ruleSchema),
  providerForAsn: z.record(z.string(), z.string()).optional(),
});

/** Load an optional deployment classification override from a JSON file. */
function loadClassification(file: string | undefined): { rules: ClassificationRule[]; providerForAsn: Record<number, string> } {
  if (!file) return { rules: DEFAULT_CLASSIFICATION_RULES, providerForAsn: DEFAULT_PROVIDER_FOR_ASN };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`CloudVision configuration: cannot read CLOUDVISION_CLASSIFICATION_FILE: ${err instanceof Error ? err.message : 'unreadable'}`, { cause: err });
  }
  const parsed = classificationFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`CloudVision configuration: invalid classification file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const rules = parsed.data.rules as ClassificationRule[];
  validateClassificationRules(rules);
  const providerForAsn: Record<number, string> = {};
  for (const [asn, provider] of Object.entries(parsed.data.providerForAsn ?? {})) {
    const n = Number(asn);
    if (Number.isInteger(n)) providerForAsn[n] = provider;
  }
  return { rules, providerForAsn };
}

export function loadCloudVisionConfig(env: NodeJS.ProcessEnv = process.env): CloudVisionConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid CloudVision configuration: ${detail}`);
  }
  const p = parsed.data;

  if (p.CLOUDVISION_CRITICAL_PERCENT < p.CLOUDVISION_WARNING_PERCENT) {
    throw new Error('CloudVision configuration: CLOUDVISION_CRITICAL_PERCENT must be ≥ CLOUDVISION_WARNING_PERCENT.');
  }

  const edgeDeviceIds = (p.CLOUDVISION_EDGE_DEVICE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const { rules, providerForAsn } = loadClassification(p.CLOUDVISION_CLASSIFICATION_FILE);
  validateClassificationRules(rules);

  const base: CloudVisionConfig = {
    enabled: p.CLOUDVISION_ENABLED,
    mode: p.CLOUDVISION_MODE,
    edgeDeviceIds,
    timeoutSeconds: p.CLOUDVISION_TIMEOUT_SECONDS,
    pollIntervalSeconds: p.CLOUDVISION_POLL_INTERVAL_SECONDS,
    verifyTls: p.CLOUDVISION_VERIFY_TLS,
    maxSampleAgeSeconds: p.CLOUDVISION_MAX_SAMPLE_AGE_SECONDS,
    retryAttempts: p.CLOUDVISION_RETRY_ATTEMPTS,
    warningPercent: p.CLOUDVISION_WARNING_PERCENT,
    criticalPercent: p.CLOUDVISION_CRITICAL_PERCENT,
    primaryDirection: p.CLOUDVISION_PRIMARY_DIRECTION,
    classificationRules: rules,
    providerForAsn,
  };

  // Disabled or mock: no credentials required, ever.
  if (!p.CLOUDVISION_ENABLED || p.CLOUDVISION_MODE === 'mock') return base;

  // Live: endpoint + token are mandatory and must be safe.
  const endpoint = (p.CLOUDVISION_ENDPOINT ?? '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('CloudVision configuration: live mode requires CLOUDVISION_ENDPOINT.');
  if (p.NODE_ENV !== 'development' && !/^https:\/\//i.test(endpoint)) {
    throw new Error('CloudVision configuration: CLOUDVISION_ENDPOINT must use HTTPS outside development.');
  }
  const token = readSecretFile(TOKEN_SECRET) ?? p.CLOUDVISION_TOKEN;
  if (!token) throw new Error('CloudVision configuration: live mode requires a service-account token (/run/secrets/cloudvision_token or CLOUDVISION_TOKEN).');

  return { ...base, endpoint, token };
}

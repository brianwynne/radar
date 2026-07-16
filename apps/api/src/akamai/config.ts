// Akamai connector configuration. READ-ONLY: no field can enable a write. Telemetry arrives as
// DataStream 2 edge logs delivered to an S3 bucket; RADAR pulls new objects and aggregates them.
// The S3 secret key is sourced from a mounted secret first (/run/secrets/akamai_s3_secret_key) then
// AKAMAI_S3_SECRET_KEY, and is NEVER logged. Disabled mode requires no credentials.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export interface AkamaiConfig {
  enabled: boolean;
  /** Rolling per-second retention window (seconds). DS2 delivers with ~min latency, so keep a few min. */
  windowSeconds: number;
  /** CP codes to observe; empty → every CP code seen in the stream. */
  cpCodes: string[];
  /** CP code → friendly name, e.g. { "1629049": "LIVE.RTE.IE" }. */
  cpNames: Record<string, string>;
  /** Shared secret required on the HTTPS ingest route (empty → ingest route disabled). */
  ingestSecret: string;
  /** S3 source (the DS2 destination RADAR polls). Empty bucket → S3 polling disabled. */
  s3: {
    bucket: string;
    region: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    pollIntervalSeconds: number;
  };
}

const S3_SECRET_FILE = '/run/secrets/akamai_s3_secret_key';

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  AKAMAI_ENABLED: boolFrom(false),
  AKAMAI_WINDOW_SECONDS: z.coerce.number().int().positive().min(30).max(3600).default(300),
  AKAMAI_CP_CODES: z.string().optional(),
  AKAMAI_CP_NAMES: z.string().optional(), // "code=Name,code=Name"
  AKAMAI_INGEST_SECRET: z.string().optional(),
  AKAMAI_S3_BUCKET: z.string().optional(),
  AKAMAI_S3_REGION: z.string().default('us-east-1'),
  AKAMAI_S3_PREFIX: z.string().default(''),
  AKAMAI_S3_ACCESS_KEY_ID: z.string().optional(),
  AKAMAI_S3_SECRET_KEY: z.string().optional(),
  AKAMAI_S3_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().min(5).max(3600).default(30),
});

function readSecretFile(path: string): string | undefined {
  try {
    if (existsSync(path)) { const v = readFileSync(path, 'utf8').trim(); return v.length > 0 ? v : undefined; }
  } catch { /* fall through */ }
  return undefined;
}

const csv = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

function parseNames(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of csv(v)) { const i = pair.indexOf('='); if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
  return out;
}

export function loadAkamaiConfig(env: NodeJS.ProcessEnv = process.env): AkamaiConfig {
  const p = schema.parse(env);
  const secretKey = readSecretFile(S3_SECRET_FILE) ?? p.AKAMAI_S3_SECRET_KEY ?? '';
  return {
    enabled: p.AKAMAI_ENABLED,
    windowSeconds: p.AKAMAI_WINDOW_SECONDS,
    cpCodes: csv(p.AKAMAI_CP_CODES),
    cpNames: parseNames(p.AKAMAI_CP_NAMES),
    ingestSecret: p.AKAMAI_INGEST_SECRET ?? '',
    s3: {
      bucket: p.AKAMAI_S3_BUCKET ?? '',
      region: p.AKAMAI_S3_REGION,
      prefix: p.AKAMAI_S3_PREFIX,
      accessKeyId: p.AKAMAI_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: secretKey,
      pollIntervalSeconds: p.AKAMAI_S3_POLL_INTERVAL_SECONDS,
    },
  };
}

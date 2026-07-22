// RIPE Atlas resolver-reader configuration. READ-ONLY (the connector only READS measurement
// results; the recurring measurements are created out-of-band). The API key is sourced from a
// mounted secret first, then ATLAS_API_KEY, and is NEVER logged. Mock mode needs no credentials.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type AtlasMode = 'mock' | 'live';

/** One ISP → its ASN and the recurring RIPE Atlas measurement id (null = no probe coverage). */
export interface AtlasIspMeasurement {
  isp: string;
  asn: number;
  measurementId: number | null;
}

export interface AtlasConfig {
  enabled: boolean;
  /** Measurement-management gate (create/stop). Reads work without it; mutations require it on. */
  writeEnabled: boolean;
  mode: AtlasMode;
  endpoint: string;
  apiKey?: string;
  /** The steering record the measurements query. */
  target: string;
  /** Edge (liveedge A) TTL at/below which a resolver is deemed to honour the low TTL. */
  honourTtlThreshold: number;
  measurements: AtlasIspMeasurement[];
  /** whoami (whoami.ds.akahelp.net TXT) measurements — reveal each ISP's REAL recursive resolvers
   *  behind the CPE forwarders, and the ECS they forward (which governs steering precision). */
  whoamiMeasurements: AtlasIspMeasurement[];
}

const KEY_SECRET = '/run/secrets/atlas_api_key';

// The measurements RADAR created (2026-07-20). Three (AS13280) has no Atlas probes → no coverage.
const DEFAULT_MEASUREMENTS: AtlasIspMeasurement[] = [
  { isp: 'Eir', asn: 5466, measurementId: 192119190 },
  { isp: 'Sky', asn: 5607, measurementId: 192119191 },
  { isp: 'Virgin/LG', asn: 6830, measurementId: 192119193 },
  { isp: 'Vodafone', asn: 15502, measurementId: 192119194 },
  { isp: 'Three', asn: 13280, measurementId: null },
];

// whoami (whoami.ds.akahelp.net TXT) measurements — reveal each ISP's REAL recursive resolver IPs
// behind the CPE forwarders, plus the ECS they send. Created 2026-07-20.
const DEFAULT_WHOAMI_MEASUREMENTS: AtlasIspMeasurement[] = [
  { isp: 'Eir', asn: 5466, measurementId: 192320576 },
  { isp: 'Sky', asn: 5607, measurementId: 192320577 },
  { isp: 'Virgin/LG', asn: 6830, measurementId: 192320578 },
  { isp: 'Vodafone', asn: 15502, measurementId: 192320579 },
  { isp: 'Three', asn: 13280, measurementId: null },
];

const boolFrom = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))), z.boolean());

const schema = z.object({
  ATLAS_ENABLED: boolFrom(false),
  // Measurement MANAGEMENT gate (create-on-check-now / create+delete-on-polling). Default OFF, like
  // NS1_WRITE_ENABLED: reads work without it, but RADAR won't create/stop RIPE Atlas measurements
  // (which spend credits) until it's explicitly enabled.
  ATLAS_WRITE_ENABLED: boolFrom(false),
  ATLAS_MODE: z.enum(['mock', 'live']).default('mock'),
  ATLAS_ENDPOINT: z.string().default('https://atlas.ripe.net/api/v2'),
  ATLAS_API_KEY: z.string().optional(),
  ATLAS_TARGET: z.string().default('live.rte.ie'),
  // Edge (liveedge A) TTL is 30s; a resolver honouring it returns ≤ this. Above → it caps/floors
  // the low TTL upward (30 + a small margin for jitter).
  ATLAS_HONOUR_TTL_THRESHOLD: z.coerce.number().int().positive().max(3600).default(35),
  ATLAS_MEASUREMENTS: z.string().optional(),
  ATLAS_WHOAMI_MEASUREMENTS: z.string().optional(),
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

const measurementSchema = z.array(z.object({ isp: z.string(), asn: z.number().int(), measurementId: z.number().int().nullable() }));

export function loadAtlasConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid RIPE Atlas configuration: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const p = parsed.data;
  let measurements = DEFAULT_MEASUREMENTS;
  if (p.ATLAS_MEASUREMENTS) {
    let raw: unknown;
    try {
      raw = JSON.parse(p.ATLAS_MEASUREMENTS);
    } catch (err) {
      throw new Error(`RIPE Atlas configuration: ATLAS_MEASUREMENTS is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`, { cause: err });
    }
    const m = measurementSchema.safeParse(raw);
    if (!m.success) throw new Error(`RIPE Atlas configuration: invalid ATLAS_MEASUREMENTS: ${m.error.issues.map((i) => i.message).join('; ')}`);
    measurements = m.data;
  }
  let whoamiMeasurements = DEFAULT_WHOAMI_MEASUREMENTS;
  if (p.ATLAS_WHOAMI_MEASUREMENTS) {
    let raw: unknown;
    try {
      raw = JSON.parse(p.ATLAS_WHOAMI_MEASUREMENTS);
    } catch (err) {
      throw new Error(`RIPE Atlas configuration: ATLAS_WHOAMI_MEASUREMENTS is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`, { cause: err });
    }
    const m = measurementSchema.safeParse(raw);
    if (!m.success) throw new Error(`RIPE Atlas configuration: invalid ATLAS_WHOAMI_MEASUREMENTS: ${m.error.issues.map((i) => i.message).join('; ')}`);
    whoamiMeasurements = m.data;
  }

  const base: AtlasConfig = {
    enabled: p.ATLAS_ENABLED,
    writeEnabled: p.ATLAS_WRITE_ENABLED,
    mode: p.ATLAS_MODE,
    endpoint: p.ATLAS_ENDPOINT.replace(/\/+$/, ''),
    target: p.ATLAS_TARGET,
    honourTtlThreshold: p.ATLAS_HONOUR_TTL_THRESHOLD,
    measurements,
    whoamiMeasurements,
  };

  if (!p.ATLAS_ENABLED || p.ATLAS_MODE === 'mock') return base;

  const apiKey = readSecretFile(KEY_SECRET) ?? p.ATLAS_API_KEY;
  if (!apiKey) throw new Error('RIPE Atlas configuration: live mode requires an API key (/run/secrets/atlas_api_key or ATLAS_API_KEY).');
  return { ...base, apiKey };
}

// Database configuration. Validated at startup so that misconfiguration (e.g. an invalid
// pool size) fails fast. The connection string is never logged; use redactDatabaseUrl for
// any diagnostic output. Actual connectivity is not tested here — a database that is
// merely unreachable must fail readiness, not startup.
import { z } from 'zod';

export interface DatabaseConfig {
  url: string;
  poolMin: number;
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
}

const schema = z.object({
  // zod 4: a string `error` sets the default message for all issues (missing or empty).
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(0),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid database configuration: ${detail}`);
  }
  const p = parsed.data;
  if (p.DATABASE_POOL_MIN > p.DATABASE_POOL_MAX) {
    throw new Error(
      `Invalid database configuration: DATABASE_POOL_MIN (${p.DATABASE_POOL_MIN}) cannot exceed DATABASE_POOL_MAX (${p.DATABASE_POOL_MAX}).`,
    );
  }
  return {
    url: p.DATABASE_URL,
    poolMin: p.DATABASE_POOL_MIN,
    poolMax: p.DATABASE_POOL_MAX,
    connectionTimeoutMs: p.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: p.DATABASE_IDLE_TIMEOUT_MS,
    statementTimeoutMs: p.DATABASE_STATEMENT_TIMEOUT_MS,
  };
}

/** A credential-free descriptor of a connection string, safe to log. */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable database url)';
  }
}

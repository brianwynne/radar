// A single application-wide connection pool. RADAR opens no per-request connections:
// handlers borrow from this bounded pool and return promptly. Acquisition and per-
// statement time are bounded so a slow or exhausted database surfaces as an error rather
// than an unbounded hang.
import pg from 'pg';
import type { DatabaseConfig } from './config.js';

export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.url,
    min: config.poolMin,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    // Server-side ceiling on any single statement (guards against a runaway query
    // holding a pooled connection).
    statement_timeout: config.statementTimeoutMs,
  });
}

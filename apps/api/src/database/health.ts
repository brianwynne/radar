// Readiness probe for the database. A transient failure (database down, pool exhausted)
// yields `unavailable` so readiness fails, while liveness is unaffected — the process is
// healthy and should not be restarted merely because the database blipped.
import type { Pool } from 'pg';

export interface DatabaseHealth {
  status: 'ok' | 'unavailable';
  error?: string;
}

export type DatabaseHealthCheck = () => Promise<DatabaseHealth>;

/** A bounded readiness probe. The pool's connectionTimeout/statement_timeout bound how
 *  long this can take; any error is reported (never thrown) as `unavailable`. */
export function databaseHealthCheck(pool: Pool): DatabaseHealthCheck {
  return async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch (err) {
      return { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
    }
  };
}

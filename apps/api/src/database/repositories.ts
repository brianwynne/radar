// Application database access. Read repositories run on the app-wide pool; a transaction()
// helper borrows a single client so a snapshot and its audit event are written atomically
// (both or neither). Repositories come from @radar/data (framework-independent); this
// module only composes them over the pg pool/client.
import type { Pool } from 'pg';
import {
  PostgresAuditRepository,
  PostgresSnapshotRepository,
  type AuditRepository,
  type Queryable,
  type SnapshotRepository,
} from '@radar/data';

export interface Repositories {
  snapshots: SnapshotRepository;
  audit: AuditRepository;
}

export interface Database extends Repositories {
  /** Run `fn` inside a single transaction (BEGIN/COMMIT; ROLLBACK on error). The repos
   *  passed to `fn` share one client, so their writes commit or roll back together. */
  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

export function createDatabase(pool: Pool): Database {
  const q = pool as unknown as Queryable;
  return {
    snapshots: new PostgresSnapshotRepository(q),
    audit: new PostgresAuditRepository(q),
    async transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const cq = client as unknown as Queryable;
      try {
        await client.query('BEGIN');
        const result = await fn({
          snapshots: new PostgresSnapshotRepository(cq),
          audit: new PostgresAuditRepository(cq),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

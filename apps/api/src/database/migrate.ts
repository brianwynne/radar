// One-shot migration runner. Run explicitly (npm run migrate / the radar-migrate compose
// service), never automatically from every API replica.
//
// SESSION OWNERSHIP: `pg_advisory_lock` is session-scoped, so a SINGLE retained client
// (one pg session) is used for the whole operation — lock acquisition, migration
// inspection, migration execution and lock release. We deliberately do not take the lock
// on a pooled query and then run migrations on unrelated pooled sessions. The lock is
// released in `finally`, so it is released after success AND after failure.
import { applyMigrations, loadMigrations } from '@radar/data';
import { loadDatabaseConfig, redactDatabaseUrl } from './config.js';
import { createPool } from './pool.js';

// Stable, arbitrary key identifying the RADAR schema-migration lock.
const MIGRATION_ADVISORY_LOCK = 5203071;

async function main(): Promise<void> {
  const config = loadDatabaseConfig(process.env);
  const pool = createPool(config);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    const applied = await applyMigrations(client, loadMigrations());
    if (applied.length > 0) {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    } else {
      console.log('No pending migrations.');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]).catch(() => undefined);
    client.release();
    await pool.end();
  }
  console.log(`Migrations complete for ${redactDatabaseUrl(config.url)}.`);
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

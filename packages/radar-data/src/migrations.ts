// Source-controlled schema migrations. Migrations are plain, deterministic `*.sql` files
// applied in filename order; each is recorded in `schema_migrations` so re-running is a
// no-op. This module contains no database-driver dependency — it runs against any
// `Queryable`. Concurrency control (so replicas do not migrate simultaneously) is the
// caller's responsibility; radar-api wraps this in a PostgreSQL advisory lock.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from './types.js';

export interface MigrationFile {
  name: string;
  sql: string;
}

/** Directory containing this package's migration SQL. The `migrations/` folder sits at
 *  the package root, a sibling of both `src/` (dev/tsx) and `dist/` (built), so the same
 *  relative resolution works in every mode. */
export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

export function loadMigrations(dir: string = migrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/** Split a migration file into individual statements, honouring single-quoted string
 *  literals so a `;` inside a literal is not treated as a terminator. Line comments
 *  (`-- ...`) are stripped first. Migration authors must not place `--` inside a string
 *  literal. */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (const ch of withoutComments) {
    if (ch === "'") inString = !inString;
    if (ch === ';' && !inString) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Apply any not-yet-recorded migrations in order and record each. Idempotent. Returns
 *  the names actually applied this run. */
export async function applyMigrations(
  db: Queryable,
  migrations: MigrationFile[] = loadMigrations(),
): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    for (const statement of splitStatements(migration.sql)) {
      await db.query(statement);
    }
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    ran.push(migration.name);
  }
  return ran;
}

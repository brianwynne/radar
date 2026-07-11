// Source-controlled schema migrations. Migrations are plain, deterministic `*.sql` files
// applied in lexical filename order. Each is executed as a SINGLE PostgreSQL query inside
// its own transaction (PostgreSQL parses multiple statements and dollar-quoted bodies
// natively — there is no home-grown SQL splitter) and recorded in `schema_migrations`
// with its SHA-256 checksum. Re-running is a no-op; a recorded migration whose file
// checksum has since changed is rejected.
//
// SESSION OWNERSHIP: advisory locking and transactions are session-scoped. Callers that
// need those guarantees (the radar-api migrate command) MUST pass a single retained
// client (one pg session) as `db` — never a pool that may hand out different sessions
// per query. See apps/api/src/database/migrate.ts.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from './types.js';

export interface MigrationFile {
  /** Stable primary key, the filename without `.sql` (e.g. `0001_init`). */
  version: string;
  /** Source filename (e.g. `0001_init.sql`). */
  filename: string;
  /** Raw SQL. */
  sql: string;
  /** `sha256:<hex>` over the SQL with line endings normalised to LF. */
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  filename: string;
  applied: boolean;
  /** null when not yet applied; otherwise whether the recorded checksum matches the file. */
  checksumMatches: boolean | null;
}

/** Raised when an already-applied migration's file has been modified since it was applied
 *  (checksum mismatch). Migrations are immutable once applied. */
export class MigrationChecksumError extends Error {
  constructor(
    public readonly version: string,
    public readonly recorded: string,
    public readonly current: string,
  ) {
    super(
      `Migration ${version} has been modified since it was applied ` +
        `(recorded ${recorded}, now ${current}). Applied migrations are immutable; add a new migration instead.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

/** SHA-256 over LF-normalised content, so a CRLF/LF or OS difference does not change the
 *  checksum of otherwise-identical SQL. */
export function migrationChecksum(sql: string): string {
  return `sha256:${createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')}`;
}

/** Directory containing this package's migration SQL. The `migrations/` folder sits at
 *  the package root, a sibling of both `src/` (dev/tsx) and `dist/` (built). */
export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

/** Load migrations from the controlled directory in deterministic lexical order. Only
 *  `*.sql` files from this fixed directory are ever selected — there is no user-supplied
 *  migration path. */
export function loadMigrations(dir: string = migrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(dir, filename), 'utf8');
      return { version: filename.replace(/\.sql$/, ''), filename, sql, checksum: migrationChecksum(sql) };
    });
}

interface RecordedRow {
  version: string;
  checksum: string;
}

async function ensureTable(db: Queryable): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version      text PRIMARY KEY,
       filename     text NOT NULL,
       checksum     text NOT NULL,
       applied_at   timestamptz NOT NULL DEFAULT now(),
       execution_ms integer
     )`,
  );
}

async function recordedMap(db: Queryable): Promise<Map<string, RecordedRow>> {
  const { rows } = await db.query<RecordedRow>('SELECT version, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.version, r]));
}

/** Report, for each known migration, whether it is applied and (if so) whether its
 *  recorded checksum still matches the file. */
export async function migrationStatus(
  db: Queryable,
  migrations: MigrationFile[] = loadMigrations(),
): Promise<MigrationStatus[]> {
  await ensureTable(db);
  const recorded = await recordedMap(db);
  return migrations.map((m) => {
    const rec = recorded.get(m.version);
    return {
      version: m.version,
      filename: m.filename,
      applied: rec !== undefined,
      checksumMatches: rec ? rec.checksum === m.checksum : null,
    };
  });
}

/** Apply any not-yet-recorded migrations in order and record each. Idempotent. Each
 *  migration runs as one query inside its own transaction, so a failure rolls the whole
 *  migration back and is NOT recorded as applied. Returns the versions applied this run.
 *
 *  Pass a single retained client as `db` for transaction/advisory-lock correctness. */
export async function applyMigrations(
  db: Queryable,
  migrations: MigrationFile[] = loadMigrations(),
): Promise<string[]> {
  await ensureTable(db);
  const recorded = await recordedMap(db);

  const applied: string[] = [];
  for (const m of migrations) {
    const rec = recorded.get(m.version);
    if (rec) {
      if (rec.checksum !== m.checksum) {
        throw new MigrationChecksumError(m.version, rec.checksum, m.checksum);
      }
      continue; // already applied, unchanged
    }
    const startedAt = Date.now();
    await db.query('BEGIN');
    try {
      // PostgreSQL executes multiple statements and dollar-quoted bodies in a single
      // simple-protocol query; no parameters, so this is safe.
      await db.query(m.sql);
      await db.query(
        'INSERT INTO schema_migrations (version, filename, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
        [m.version, m.filename, m.checksum, Date.now() - startedAt],
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err; // rolled back → not recorded as applied
    }
    applied.push(m.version);
  }
  return applied;
}

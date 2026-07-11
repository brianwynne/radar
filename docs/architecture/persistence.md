# RADAR Persistence

PostgreSQL is the only durable state in RADAR (ADR-0001); radar-api and radar-web are
stateless with no application filesystem state. This document describes the persistence
foundation. See also [../development/database.md](../development/database.md) (how to run
it), [../testing/postgresql-integration.md](../testing/postgresql-integration.md) (how it
is validated), and [../operations/backup-restore.md](../operations/backup-restore.md).

## Boundary — `@radar/data`

`packages/radar-data` is a framework-independent persistence package: no Fastify, HTTP or
React. It talks to any driver satisfying a minimal `Queryable` (node-pg's `Pool`/
`PoolClient` and `pg-mem` both do), so it carries no hard dependency on a specific client.
The concrete `pg.Pool` is composed only in `apps/api`. Consumers depend on **interfaces**,
not concrete implementations:

- `SnapshotRepository` → `PostgresSnapshotRepository`
- `AuditRepository` → `PostgresAuditRepository`

Row mapping is defensive about real PostgreSQL wire-format differences (JSONB, `text[]`,
timestamps); it embeds no emulated database semantics. Repositories never open their own
connections — they use the `Queryable` handed to them (the app-wide pool, or a client
inside a transaction for multi-step writes). Transaction control is owned by the caller.

## Schema

Migration `0001_init.sql` creates:

- **`configuration_snapshots`** — immutable captures of upstream configuration (e.g. NS1
  zones/records). UUID primary key. The raw payload is preserved verbatim as `jsonb`
  alongside a canonical form and integrity checksums (`raw_checksum`,
  `structural_checksum`). Indexed by resource identity + `retrieved_at`, by source system,
  by checksum, and by creation time. Payloads live **inline as JSONB** — nothing is
  written to the filesystem or blob storage.
- **`audit_events`** — the security/operational audit trail. UUID primary key.
  `actor_roles` is a native PostgreSQL **`text[]`**; `details` is `jsonb`. Indexed by
  occurrence time, actor, action, resource, and correlation id. **`details` must never
  contain tokens, API keys, credentials, or complete sensitive headers** — callers redact
  before recording.

`schema_migrations` (created by the runner) tracks applied migrations: `version` (primary
key), `filename`, `checksum` (SHA-256), `applied_at`, and `execution_ms`.

## Connection pool

One bounded, application-wide pool (`apps/api/src/database/pool.ts`), configured from
`DATABASE_URL` plus optional `DATABASE_POOL_*` / `*_TIMEOUT_MS` variables
(`apps/api/src/database/config.ts`). Acquisition and per-statement time are bounded so a
slow or exhausted database surfaces as a safe error, not a hang. The pool is closed on
graceful shutdown. The connection string is **never logged** — use `redactDatabaseUrl`.

- **Configuration errors** (missing `DATABASE_URL`, invalid pool sizes) **fail startup.**
- A **transiently unreachable** database **fails readiness only** (`/api/v1/health/ready`
  → `503`, `checks.database: unavailable`, no host/SQL detail); **liveness stays healthy**
  — the process is fine and must not be restarted for a database blip.
- **`not_wired`** (no probe wired) is **also 503** — a deployment must never report ready
  while PostgreSQL is unwired. In production the probe is always wired (DATABASE_URL is
  required to start); `not_wired` arises only in unit tests.

## Migrations

Plain, source-controlled `*.sql` files in `packages/radar-data/migrations/`, applied in
**lexical filename order** by `applyMigrations`. Each migration is executed as a **single
PostgreSQL query inside its own transaction** — PostgreSQL parses multiple statements and
dollar-quoted bodies natively, so there is **no home-grown SQL splitter** — and then
recorded in `schema_migrations` with its SHA-256 checksum and execution time. Properties:

- **Idempotent** — an already-recorded migration is skipped.
- **Immutable** — if a recorded migration's file checksum has changed, the runner
  **rejects** it (`MigrationChecksumError`); add a new migration instead.
- **Transactional** — a failed migration rolls back entirely and is **not** recorded.
- **Checksum stability** — SHA-256 is computed over LF-normalised content, so CRLF/LF or
  OS differences do not change it.

Migrations run **out-of-band**, never automatically from an API replica:

- Local/dev: `npm run migrate -w @radar/api` (built) or `npm run migrate:dev -w @radar/api`.
- Compose: the one-shot **`radar-migrate`** service runs to completion
  (`service_completed_successfully`) before `radar-api` starts.

### Advisory-lock session model

`pg_advisory_lock` is **session-scoped**. The runner (`apps/api/src/database/migrate.ts`)
therefore holds **one dedicated `pg` client (one session)** for the entire operation —
lock acquisition, migration inspection, migration execution, and lock release — and never
acquires the lock on a pooled query then migrates on unrelated pooled sessions. The lock
is released in `finally`, so it is released after **success and after failure**. This
serialises concurrent runners so replicas cannot apply the same migration simultaneously.

## Testing

See [../testing/postgresql-integration.md](../testing/postgresql-integration.md). In
short: **real PostgreSQL integration tests are authoritative** (CI, `postgres:17`);
**pg-mem is fast supplementary only** and must never be reported as PostgreSQL validation.

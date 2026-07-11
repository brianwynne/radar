# RADAR Persistence

PostgreSQL is the only durable state in RADAR (ADR-0001); radar-api and radar-web are
stateless. This document describes the persistence foundation.

## Boundary — `@radar/data`

`packages/radar-data` is a framework-independent persistence package: no Fastify, HTTP or
React. It talks to any driver satisfying a minimal `Queryable` (node-pg's `Pool`/
`PoolClient` and `pg-mem` both do), so it carries no hard dependency on a specific client.
Consumers depend on **interfaces**, not concrete implementations:

- `SnapshotRepository` → `PostgresSnapshotRepository`
- `AuditRepository` → `PostgresAuditRepository`

Row mapping is defensive about driver differences (JSONB and timestamp shapes), and the
repositories never open their own connections — they use the `Queryable` handed to them
(the app-wide pool, or a client inside a transaction for multi-step writes).

## Schema

Migration `0001_init.sql` creates:

- **`configuration_snapshots`** — immutable captures of upstream configuration (e.g. NS1
  zones/records). The raw payload is preserved verbatim as JSONB alongside a canonical
  form and integrity checksums (`raw_checksum`, `structural_checksum`). Indexed by
  resource identity + `retrieved_at`, by source system, by checksum, and by creation
  time. Payloads live **inline as JSONB** — nothing is written to the filesystem or blob
  storage.
- **`audit_events`** — the security/operational audit trail. Indexed by occurrence time,
  actor, action, resource, and correlation id. **`details` must never contain tokens,
  API keys, credentials, or complete sensitive headers** — callers redact before
  recording.

Both keys are application-generated UUIDs.

## Connection pool

One bounded, application-wide pool (`apps/api/src/database/pool.ts`), configured from
`DATABASE_URL` plus optional `DATABASE_POOL_*` / `*_TIMEOUT_MS` variables
(`apps/api/src/database/config.ts`). Acquisition and per-statement time are bounded so a
slow or exhausted database surfaces as an error, not a hang. The pool is closed on
graceful shutdown. The connection string is **never logged** — use `redactDatabaseUrl`.

- **Configuration errors** (missing `DATABASE_URL`, invalid pool sizes) **fail startup.**
- A **transiently unreachable** database **fails readiness only** (`/api/v1/health/ready`
  → `503`, `checks.database: unavailable`); **liveness stays healthy** — the process is
  fine and must not be restarted for a database blip.

## Migrations

Plain, source-controlled `*.sql` files in `packages/radar-data/migrations/`, applied in
filename order by a small runner (`applyMigrations`) that records each in
`schema_migrations` and is therefore idempotent. Migrations are **deterministic** and
**CI-validatable**, and are run **out-of-band**, never automatically from every API
replica:

- Local/dev: `npm run migrate -w @radar/api` (built) or `npm run migrate:dev -w @radar/api` (tsx).
- Compose: the one-shot `migrate` service runs to completion (`service_completed_successfully`)
  before `radar-api` starts.

The runner (`apps/api/src/database/migrate.ts`) wraps application in a PostgreSQL
**advisory lock** so concurrent runners cannot migrate simultaneously.

## Testing without Docker

Repository and migration tests run against **`pg-mem`** (in-memory PostgreSQL), applying
the real `0001_init.sql`, so schema/code drift is caught without a live database. CI and
local `docker compose` still exercise real PostgreSQL.

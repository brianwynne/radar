# PostgreSQL integration testing

RADAR validates its persistence layer in **two deliberately distinct tiers**.

## Authoritative — real PostgreSQL

The authoritative proof runs against a **real PostgreSQL server**:

- `packages/radar-data/test/integration/postgres.integration.test.ts`
- `apps/api/test/readiness.integration.test.ts`

They are the source of truth for the persistence layer and cover:

- **Migration runner** — bootstraps `schema_migrations`; applies `0001_init.sql` in
  lexical order with recorded checksum + execution time; idempotent re-run; applied vs
  pending status; **checksum-mutation rejection**; **failed migration rolled back and not
  recorded** (transactional); **advisory-lock** mutual exclusion across two concurrent
  runners; lock released after success and after failure.
- **Schema catalog** — via `information_schema` / `pg_catalog`: required columns; UUID
  primary keys; `jsonb` types; `timestamptz` types; `audit_events.actor_roles` as a real
  `text[]`; NOT NULL constraints; defaults; every declared index.
- **Repositories** — snapshot and audit create/get/list with all filters, ordering,
  bounded limits, and **semantic JSON equality** for raw/canonical/nested/array/scalar
  payloads, metadata, `text[]` roles, unicode, nullable fields and timestamps.
- **Transactions & connections** — commit persists, rollback discards with no partial
  state, savepoint-based nested rollback, statement-timeout surfaces the safe
  `query_canceled` (`57014`) category, and the pool stays usable after a query error.
- **Readiness/liveness** — 200/`ok` against a real database; 503/`unavailable` against an
  unreachable one with no host/SQL leakage; liveness stays 200; graceful shutdown.

### Running locally

Point `TEST_DATABASE_URL` at a **disposable** database — these tests are **destructive**
(they drop and recreate schema). **Never** use the production `DATABASE_URL`.

```bash
export TEST_DATABASE_URL='postgres://user:pass@localhost:5432/radar_test'
npm run test:integration                      # all workspaces
npm run test:integration:postgres -w @radar/data
```

A disposable Compose database works well:

```bash
docker compose up -d postgres
export TEST_DATABASE_URL='postgres://radar:radar@localhost:5432/radar'
npm run test:integration
```

If `TEST_DATABASE_URL` is unset the suite **skips with a clear message** — but only
locally. In CI, `REQUIRE_REAL_PG=1` makes a missing URL a hard failure, so a skipped
PostgreSQL suite is **never** silently reported as passing PostgreSQL validation.

### In CI

The `postgres-integration` job runs against a pinned `postgres:17` service container with
`TEST_DATABASE_URL` and `REQUIRE_REAL_PG=1` set. It applies migrations with the real
runner, checks idempotency, then runs the integration suites. The `docker-compose` job
additionally starts `postgres → radar-migrate → radar-api` in order and asserts the API
reports the database reachable; the `docker-image` job builds and smoke-tests the API
image.

## Fast supplementary — pg-mem

The default `npm run test:unit` suite uses **pg-mem** (in-memory PostgreSQL) applying the
real `0001_init.sql`. It gives quick feedback with no external services but is **not**
authoritative PostgreSQL coverage — pg-mem emulates and differs (no real transaction
rollback, a stricter AST-coverage guard, looser array-default handling). Never cite pg-mem
as PostgreSQL validation.

## Supported PostgreSQL version

PostgreSQL **17** is pinned in `docker-compose.yml` and CI. Keep both in step when
upgrading.

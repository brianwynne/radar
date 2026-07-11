# Database — local development

RADAR uses PostgreSQL as its only durable state. Supported/target version: **PostgreSQL
17** (pinned in `docker-compose.yml` and CI; the engine works on 16–18).

## Configuration

`radar-api` requires `DATABASE_URL` to start. Optional tuning (defaults shown):

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required. Never logged. |
| `DATABASE_POOL_MIN` | `0` | |
| `DATABASE_POOL_MAX` | `10` | Bounded (≤100). |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Acquisition timeout. |
| `DATABASE_IDLE_TIMEOUT_MS` | `30000` | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | Server-side per-statement ceiling. |

Invalid configuration (missing URL, `POOL_MIN > POOL_MAX`, non-positive `POOL_MAX`) fails
startup. See [`.env.example`](../../.env.example).

## Run PostgreSQL with Compose

```bash
docker compose up -d postgres          # starts PostgreSQL 17 (dev port 5432 published)
```

The published port is **development-only**; production must not expose the database.

## Apply migrations

Migrations are applied **out-of-band**, never on API boot:

```bash
# built:
npm run migrate -w @radar/api
# or from TypeScript sources:
npm run migrate:dev -w @radar/api
```

or via the one-shot compose service:

```bash
docker compose run --rm radar-migrate
```

The runner is idempotent, rejects modified applied migrations, is transactional per
migration, and serialises concurrent runners with a session-scoped advisory lock. See
[../architecture/persistence.md](../architecture/persistence.md).

## Full vertical slice

```bash
docker compose up -d --build radar-api   # postgres -> radar-migrate -> radar-api, in order
docker compose exec -T radar-api wget -qO- http://localhost:3000/api/v1/health/ready
docker compose down -v                    # tear down and remove the volume
```

## Adding a migration

1. Create `packages/radar-data/migrations/NNNN_description.sql` (next lexical number).
2. Write transaction-safe DDL. Do not modify an already-applied migration — the runner
   rejects a changed checksum; add a new migration instead.
3. Validate with the real-PostgreSQL integration tests
   ([../testing/postgresql-integration.md](../testing/postgresql-integration.md)).

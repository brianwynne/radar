# Backup & restore (PostgreSQL)

PostgreSQL holds RADAR's only durable state (configuration snapshots and audit history);
`radar-api`/`radar-web` are stateless with no filesystem state, so **the database is the
sole backup target**. Migrations are source-controlled and reproducible, so the schema is
recoverable from the repository — backups protect the **data**.

## What to back up

- The RADAR database (all tables, including `configuration_snapshots`, `audit_events`,
  `schema_migrations`).
- Do **not** rely on backing up container filesystems — nothing durable lives there.

## Logical backup (portable)

```bash
# Dump (custom format, compressed):
pg_dump --format=custom --no-owner --dbname "$DATABASE_URL" --file radar-$(date +%F).dump

# Restore into a clean database:
pg_restore --clean --if-exists --no-owner --dbname "$TARGET_DATABASE_URL" radar-YYYY-MM-DD.dump
```

`audit_events` is an append-only history; treat its retention per policy. `raw_payload`
and `canonical_payload` are JSONB and are captured verbatim by `pg_dump`.

## Physical / point-in-time recovery

For larger deployments use the platform's managed PITR (base backup + WAL archiving) or
`pg_basebackup`. RADAR imposes no special requirements here.

## Compose volume

The dev stack stores data in the named volume `radar_pgdata`. `docker compose down`
preserves it; **`docker compose down -v` deletes it** (used in CI, which is disposable).
Back up with `pg_dump` before removing volumes you care about.

## Restore validation

After a restore, confirm the schema is at the expected migration and the app is ready:

```bash
npm run migrate -w @radar/api    # should report "No pending migrations."
# then, with the API running:
curl -fsS http://<api>/api/v1/health/ready    # expect status ready, checks.database: ok
```

## Disposable databases for testing

Integration tests are **destructive** and must target a disposable database via
`TEST_DATABASE_URL` — never a backup source or production. See
[../testing/postgresql-integration.md](../testing/postgresql-integration.md).

## Security

Backups contain audit history and captured configuration. Store them encrypted at rest
with restricted access. Connection strings used by `pg_dump`/`pg_restore` carry
credentials — keep them out of shell history and logs (RADAR itself never logs the
connection string).

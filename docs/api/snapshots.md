# RADAR API — configuration snapshots

Snapshots capture an NS1 record's configuration for version history and comparison. This
is **not** an NS1 write: capture *reads* the record via the read-only NS1 client and
persists it in RADAR's PostgreSQL. There is no rollback execution, no scheduling, no
background workers.

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /api/v1/ns1/zones/:zone/:domain/:type/snapshots` | `snapshot.create` | Capture the record now. |
| `GET  /api/v1/ns1/zones/:zone/:domain/:type/snapshots` | `snapshot.read` | History for the record (summaries, newest first). |
| `GET  /api/v1/snapshots/:snapshotId` | `snapshot.read` | Snapshot detail (with payloads). |
| `POST /api/v1/snapshots/compare` | `snapshot.read` | Structural diff of two snapshots. |
| `POST /api/v1/snapshots/:snapshotId/compare-current` | `snapshot.read` | Diff a snapshot against the **current** record. |

All require authentication; RBAC is enforced server-side. OpenAPI at `/api/v1/openapi.json`.

## Capture
Fetches the record (raw), then stores:
- **`rawPayload`** — the record verbatim (raw preservation).
- **`canonicalPayload`** — key-sorted canonical form (array/filter/answer order preserved).
- **`rawChecksum`**, **`structuralChecksum`** — SHA-256 of raw and canonical forms.
- **metadata** — `{ mode, synthetic, warnings }` (synthetic + a warning in mock mode).
- **createdBySubject**, **retrievedAt**, optional **label** (from the request body).

The snapshot and an **audit event** (`action: snapshot.create`) are written in a **single
transaction** — both commit or neither does. The audit `details` carry only the snapshot
id, checksum and mode (never secrets). Returns `201` with `{ provenance, snapshot }`.

If persistence is not configured the route returns `503 PERSISTENCE_UNAVAILABLE`. NS1
upstream failures map to safe statuses (see the NS1 read routes doc).

## History / detail
History returns **summaries** (no payloads); detail returns the full snapshot including
`rawPayload` and `canonicalPayload`. Unknown / malformed ids return `404
SNAPSHOT_NOT_FOUND`.

## Compare
`POST /api/v1/snapshots/compare` with `{ "a": "<uuid>", "b": "<uuid>" }` returns
`{ a, b (summaries), identical, diffCount, diff[] }`. `identical` is true when the
structural checksums match. `diff` is a compact list of `{ path, kind (added|removed|
changed), before?, after? }` computed over the canonical payloads. Invalid ids → `400`;
missing snapshots → `404`.

## Compare with current
`POST /api/v1/snapshots/:snapshotId/compare-current` is a **read-only** comparison of a
stored snapshot against the **current** NS1 record — it is **not** a rollback and creates
no new snapshot. Behaviour:

1. Load the snapshot; derive `zone/domain/type` from its `resourceKey` (`resourceKind`
   must be `record`).
2. Fetch the current record **server-side** via the read-only NS1 client (the request
   body is ignored — a caller cannot supply a substitute "current" payload).
3. Canonicalise it with the same logic used at capture and diff against the stored
   canonical payload.

Returns `snapshot` + `current` source metadata (mode, synthetic, checksums, timestamps),
`rawChecksumEqual`, `structuralChecksumEqual`, `identical`, a **record-aware `summary`**
(`ttlChanged`, `ecsChanged`, `answers{Added,Removed,Changed}`, `filters{Added,Removed,
Changed}`, `filtersReordered`, `otherChanges` — answer and filter order preserved),
`changes[]` (structured field diff), `warnings`, and `provenance`. Errors: snapshot
missing → `404`; current record missing → `404`; malformed resource identity → `422`;
upstream unavailable → `503`/`504`; `403` without `snapshot.read`; `401` unauthenticated.
No NS1 mutation occurs; no Restore/Apply exists.

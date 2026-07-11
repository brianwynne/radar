# RADAR Snapshots — architecture

A **snapshot** is an immutable, RADAR-side capture of an NS1 record's configuration at a
point in time. Snapshots exist for **version history, comparison and explainability** —
RADAR is read-only to NS1 (a snapshot is a record of what NS1 returned, never a change to
it).

## Model
Stored in PostgreSQL (`configuration_snapshots`, see
[persistence.md](persistence.md)) with, per snapshot:
- `resourceKind` = `record`, `resourceKey` = `zone/domain/type`, `sourceEndpoint`.
- **`rawPayload`** — the NS1 record verbatim (raw preservation).
- **`canonicalPayload`** — recursively key-sorted; **array order preserved** (answer and
  filter-chain order are significant and never reordered).
- **`rawChecksum`**, **`structuralChecksum`** — SHA-256 of the raw and canonical forms.
- **metadata** — `mode` (mock/live), `synthetic`, `warnings`; plus `createdBySubject`,
  `retrievedAt`, `createdAt`, optional `label`.

## Capture
`POST …/snapshots` reads the record via the read-only NS1 client, canonicalises, checksums,
and persists the snapshot **and its audit event in one transaction** (atomic). See
[../api/snapshots.md](../api/snapshots.md).

## Comparison
Two comparison operations, both read-only and both computed over canonical payloads:
- **snapshot ↔ snapshot** (`/snapshots/compare`) — a compact field-level diff.
- **snapshot ↔ current record** (`/snapshots/:id/compare-current`) — fetches the current
  record server-side and returns a **record-aware summary**:
  - `ttlChanged`, `ecsChanged` (from `use_client_subnet`);
  - answers matched **by id** → added / removed / changed;
  - filters matched by type/position → added / removed / changed, plus `filtersReordered`
    (same multiset, different order);
  - `otherChanges` — any remaining structural differences (e.g. unknown fields);
  - `identical` when structural checksums match.

The diff logic lives in `apps/api/src/ns1/snapshot.ts` (`canonicalise`, `rawChecksum`,
`structuralChecksum`, `diffJson`, `summariseRecordDiff`) and is shared by capture and both
comparisons, so canonicalisation is identical everywhere.

## What snapshots are NOT (v1)
No rollback/restore/apply, no change proposals, no approvals, no scheduled or automatic
capture, no background workers. See [rollback.md](rollback.md).

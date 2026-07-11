# RADAR Rollback — explicit non-goal (v1)

RADAR v1 has **no rollback, restore or apply capability**, and **no NS1 write path of any
kind**. This document records that boundary so it is not eroded by adjacent features.

## What exists
- **Snapshots** — read-only captures of NS1 records (history, detail).
- **Comparison** — snapshot ↔ snapshot, and snapshot ↔ **current** record. Comparison is
  purely analytical: it computes a diff and never changes anything.

The snapshot-detail screen shows *Compare with current* and states prominently:

> Comparison only — no NS1 change has been made.

There is deliberately **no Restore, Apply, or Rollback control** anywhere in the UI, and no
API route that mutates NS1.

## Why comparison is not rollback
`compare-current` fetches the current record server-side and diffs it against a stored
snapshot. It answers *"what changed since this snapshot?"* — it does not, and cannot,
re-apply the snapshot. Executing a change would require an NS1 write credential and write
routes, which RADAR v1 does not have and must not add (ADR-0001; the NS1 client is
GET-only, docs/ns1/developer-guide.md §2).

## If rollback is ever pursued
It would be a separate, explicitly-scoped effort with its own ADR: a write-capable
(separately-credentialed) adapter, change-proposal + approval workflow, dry-run/plan,
audited apply, and guardrails. None of that is in scope here. Until such an ADR is
accepted, snapshots remain **evidence and explanation**, not an actuator.

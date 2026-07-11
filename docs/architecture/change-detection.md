# RADAR Change Detection

Instead of continuously polling full NS1 records, RADAR watches the **NS1 Account Activity
API** and only does work when a relevant configuration change has actually occurred. It
remains **read-only to NS1** (GET only; no writes, no rollback, no remediation) and uses no
sockets or queues.

## Flow
1. (Multi-replica) Attempt the **poller lock**; if another replica holds it, stay passive
   and retry next cycle (see *Single active poller*).
2. Load the **durable checkpoint** once on first cycle so a restart resumes where it left
   off instead of re-baselining.
3. Poll the event source (default every 30 s; `CHANGE_DETECTION_INTERVAL_MS`).
4. Establish a **baseline** on first run (adopt the newest activity position, persist it, do
   nothing else).
5. Select entries **strictly newer** than the last checkpoint and drop duplicates.
6. Keep only **relevant** changes — a create/update/delete on a zone, record, answer or
   filter (reads/views are ignored).
7. For each affected watched record:
   - fetch the record via the read-only NS1 client,
   - **auto-capture a snapshot** (raw + canonical + checksums; snapshot and its audit event
     written atomically — `captureRecordSnapshot`),
   - re-evaluate all configured **Live Steering ISP scenarios** with `@radar/engine`,
   - for each ISP: build a **stable steering fingerprint**, **persist the latest state**
     (upsert), and persist a **steering-change event** *only when the fingerprint changed*
     against the previous persisted state (see *Stable fingerprint & attribution*),
   - publish an internal **`SteeringChanged`** event to subscribers,
   - record a **`steering.change.detected`** audit event.
8. Advance the checkpoint **only after successful processing**, and **persist** it.

If no relevant activity is detected, no further work is done.

## Stable fingerprint & attribution
Each ISP's steering state is reduced to a SHA-256 **fingerprint** over: eligible answer ids,
expected distribution (answer → share), complete/partial, stopped-filter index, identity
source, country, ASN, matched prefix, preferred network path, and the record's structural
checksum. It deliberately **excludes** timestamps, correlation ids and the random
**Weighted-Shuffle ordering** — so churn that carries no steering meaning produces **no
event**. A change is attributed to one of a fixed vocabulary of reasons
(`answer_became_unavailable`, `answer_became_eligible`, `asn_match_changed`,
`prefix_match_changed`, `country_match_changed`, `expected_weight_changed`,
`filter_chain_changed`, `evaluation_became_partial`, `evaluation_became_complete`,
`preferred_path_changed`, `record_checksum_changed`, `unknown_structural_change`). RADAR
**does not invent causality**: an unexplainable structural change is labelled
*"Reason not yet attributable"* (`unknown_structural_change`). On an ISP's **first**
observation there is no baseline to compare, so its state is persisted but no event is
emitted. See [../frontend/live-steering.md](../frontend/live-steering.md).

## Persistence (migration `0002_live_steering`)
- **`change_detection_checkpoints`** — one row per source; the last processed activity
  position. Loaded on startup, upserted only after a clean cycle → survives restart.
- **`live_steering_states`** — latest state per `(isp_id, resource_key)`; always upserted.
- **`steering_change_events`** — one row per *meaningful* change, with the attributed
  reason, previous/current fingerprint, previous/current state (JSONB) and checksums.

## Single active poller (multi-replica)
Polling is gated by a PostgreSQL **session-scoped advisory lock**
(`PostgresPollerLock`, `pg_try_advisory_lock` on a retained client). Only the lock holder
polls; other replicas stay passive and keep retrying. On shutdown the holder **releases**
the lock (`stop()` is async) so another replica **takes over**. Combined with the durable
checkpoint and idempotent fingerprinting, this makes duplicate processing harmless.

## Replaceable event source
The source is behind `ChangeEventSource` (`poll(): ActivityBatch`). Today that is
`Ns1ActivityEventSource` (polls `getActivity` and normalises via
`apps/api/src/ns1/activity.ts`). A future **native NS1 webhook** source can implement the
same interface (buffer pushes, return them from `poll`) with **no change** to the detection
or processing logic.

## Safety
- **Fails closed** — `runOnce()` catches everything and never throws out of the loop.
- **Backoff** — the timer delay grows on consecutive failures
  (`interval · 2^failures`, capped at 5 min) and resets on success.
- **Checkpoint preserved on failure** — a failed cycle is retried, never skipped; the
  in-memory *and durable* checkpoint advance only after a clean run.
- **Never fires without a real change** — baseline + newer-than-checkpoint + relevance
  filtering guarantee evaluations run only when NS1 config actually changed.
- Errors surface as safe codes only (no upstream detail / stack traces).

## Configuration & status
- `CHANGE_DETECTION_ENABLED` (default `false`), `CHANGE_DETECTION_INTERVAL_MS` (default
  30000). Requires a database. Started in `server.ts` after `listen`; stopped on shutdown.
- Read-only status: `GET /api/v1/change-detection/status` (`dashboard.read`) — enabled,
  running, source, interval, last run/success, checkpoint, consecutive failures, events
  published, last error. No control actions are exposed over HTTP.

## Out of scope
No NS1 writes, WebSockets, Server-Sent Events, background queues, Redis, rollback or
automatic remediation. The persisted state/events are surfaced read-only by the Live
Steering APIs ([../api/live-steering.md](../api/live-steering.md)); the frontend polls
those, it is never pushed to.

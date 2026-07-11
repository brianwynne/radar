# RADAR Change Detection

Instead of continuously polling full NS1 records, RADAR watches the **NS1 Account Activity
API** and only does work when a relevant configuration change has actually occurred. It
remains **read-only to NS1** (GET only; no writes, no rollback, no remediation) and uses no
sockets or queues.

## Flow
1. Poll the event source (default every 30 s; `CHANGE_DETECTION_INTERVAL_MS`).
2. Establish a **baseline** on first run (adopt the newest activity position, do nothing).
3. Select entries **strictly newer** than the last checkpoint and drop duplicates.
4. Keep only **relevant** changes — a create/update/delete on a zone, record, answer or
   filter (reads/views are ignored).
5. For each affected watched record:
   - fetch the record via the read-only NS1 client,
   - **auto-capture a snapshot** (raw + canonical + checksums; snapshot and its audit event
     written atomically — `captureRecordSnapshot`),
   - re-evaluate all configured **Live Steering ISP scenarios** with `@radar/engine`,
   - publish an internal **`SteeringChanged`** event to subscribers,
   - record a **`steering.change.detected`** audit event.
6. Advance the checkpoint **only after successful processing**.

If no relevant activity is detected, no further work is done.

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
  checkpoint advances only after a clean run.
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
No NS1 writes, WebSockets, Server-Sent Events, background queues, rollback or automatic
remediation (the internal `SteeringChanged` event has no fan-out consumer yet).

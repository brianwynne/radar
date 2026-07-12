# RTÉ live NS1 validation report

> **STATUS: LIVE CYCLE NOT YET EXECUTED — PARKED, AWAITING THE DEDICATED READ-ONLY NS1 KEY.**
>
> No live RTÉ NS1 data has been retrieved. This document is the **reviewed prep pack + runbook**
> plus a **mock-mode tooling rehearsal**. Every live-dependent field is marked **PENDING LIVE
> RUN**. No live findings have been invented — an empty/PENDING cell means "not yet observed",
> never "assumed compatible".

## 1. Objective & guardrails
Execute the first read-only validation of RADAR against the real RTÉ NS1 account and produce a
reviewed compatibility report before any further product work. Constraints, all honoured here:
RADAR stays **read-only** (GET only), **no NS1 writes**, **no rollback/automation/telemetry/UI**
added, and **no fixture candidate committed** until manually reviewed.

## 2. Why the live half is parked
This environment has **no NS1 credential** (`/run/secrets/ns1_api_key` absent, `NS1_API_KEY`
unset, `RADAR_MODE` defaults to mock). `https://api.nsone.net` is reachable but returns `401`
(auth required). The operator will supply the dedicated read-only key and run the cycle; this
pack makes that a short, well-defined step.

## 3. Targets (required)
| # | Target | Endpoint | Status |
|---|---|---|---|
| T1 | Zone listing | `GET /v1/zones` | **PENDING LIVE RUN** (see D-02 — not reachable via the run API yet) |
| T2 | Primary live-streaming zone (`rte.ie`) | `GET /v1/zones/rte.ie` | **PENDING LIVE RUN** |
| T3 | Main live-streaming record (`live.rte.ie/A`) | `GET /v1/zones/rte.ie/live.rte.ie/A` | **PENDING LIVE RUN** |
| T4 | A record with unsupported/unusual filters | (operator to identify the real record) | **PENDING LIVE RUN** |
| T5 | NS1 activity | `GET /v1/account/activity` | **PENDING LIVE RUN** |

## 4. Runbook (execute once the key is provided)
Read-only, GET-only. The key never reaches the browser or logs.

```bash
# 1. Provide the dedicated READ-ONLY NS1 key (either mount the secret or export for local dev):
#    /run/secrets/ns1_api_key   (preferred)   OR   export NS1_API_KEY=<read-only key>
# 2. Enable live read-only mode + the controlled live-validation gate:
export RADAR_MODE=live
export NS1_VALIDATION_ENABLED=true
# 3. Start radar-api (needs DATABASE_URL for result persistence) and authenticate as a
#    Viewing Engineer (validation.run + ns1.detail.read; ns1.raw.read for sanitised raw).
# 4. Run each target (POST is read-only — it only issues NS1 GETs):
curl -s -X POST /api/v1/validation/ns1/run -d '{"zone":"rte.ie","includeActivity":true}'          # T1(zone)+T5
curl -s -X POST /api/v1/validation/ns1/run -d '{"zone":"rte.ie","domain":"live.rte.ie","recordType":"A","includeRaw":true}'  # T3
curl -s -X POST /api/v1/validation/ns1/run -d '{"zone":"rte.ie","domain":"<record-with-unusual-filter>","recordType":"A","includeRaw":true}'  # T4
# 5. Read results + inventory:
curl -s /api/v1/validation/ns1/results
curl -s /api/v1/validation/ns1/unsupported-features
```
Or use the **/validation/ns1** screen: run each target, review per-result compatibility, and use
**Generate sanitised fixture candidate** (downloads only — never auto-commits).

> **Known gap before T1/T4 are fully covered:** "zone listing" is not yet a `run()` target and
> the fixture comparison is anchored to a single record fixture (D-02, D-03). These are logged in
> the discrepancy register with recommended narrow fixes; the operator can still validate the
> zone (T2), records (T3/T4) and activity (T5) today.

## 5. Live results — to be captured (PENDING LIVE RUN)
For **each** target, capture: schema compatibility · adapter compatibility · supported filters ·
unsupported filters · unknown fields · missing fields · type mismatches · answer groups ·
feed-controlled metadata · ECS configuration · activity-field mapping (T5) · raw checksum ·
overall status. Fill the table below from the live run:

| Target | Schema | Adapter | Supported filters | Unsupported | Unknown fields | Missing | Type mismatch | Answer groups | Feed-ctrl | ECS | Overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 zones | PENDING | PENDING | — | PENDING | PENDING | PENDING | PENDING | — | — | — | **PENDING** |
| T2 zone | PENDING | PENDING | — | PENDING | PENDING | PENDING | PENDING | — | — | — | **PENDING** |
| T3 live record | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | **PENDING** |
| T4 unusual record | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | **PENDING** |
| T5 activity | PENDING | PENDING | — | — | PENDING | PENDING | PENDING | — | — | — | **PENDING** |

### 5a. Activity-field mapping (T5) — to confirm
RADAR's activity normaliser maps heuristically (unconfirmed — see D-01); confirm each against the
live wire field name:

| RADAR field | Candidate NS1 fields (heuristic) | Live field (PENDING) |
|---|---|---|
| `id` | `id`, `activity_id` | PENDING |
| `occurredAt` | `timestamp`, `occurred_at`, `date`, `time`, `created_at` | PENDING |
| `actor` | `user`, `username`, `user_id`, `actor`, `api_key_name`, `api_key_id` | PENDING |
| `action` | `action`, `activity_type`, `type`, `method` | PENDING |
| `resourceType` | `resource_type`, `object_type` | PENDING |
| `resourceKey` | `resource_id`, `resource`, `object_id`, `object` | PENDING |

## 6. Mock-mode tooling rehearsal (SYNTHETIC — proves the pipeline, NOT a live result)
Ran the validation service against the fixture-backed mock client (no NS1 contacted). Purpose:
prove the tool runs end-to-end and to sanity-check the analysis. **These are synthetic fixture
outcomes and say nothing about live NS1.**

| Target (mock) | Overall | Supported filters | Unsupported | Feed-ctrl | ECS | Notes |
|---|---|---|---|---|---|---|
| zone `rte.ie` | `compatible` | — | — | no | absent | zone endpoint = schema check only (D-04) |
| record `live.rte.ie/A` | `compatible_with_warnings` | up, geotarget_country, netfence_asn, netfence_prefix, weighted_shuffle, select_first_n | none | **yes** | enabled | warning = feed-controlled `meta.up` |
| record `vod.rte.ie/A` | `partial` | up, weighted_shuffle, select_first_n | **shed_load** | no | enabled | fixture diff noisy vs single anchor fixture (D-03) |
| activity | `compatible` | — | — | no | absent | **schema is `z.unknown()` → check is a no-op (D-01)** |
| zones listing | `compatible` | — | — | no | absent | `z.array(z.unknown())`; not wired into run() (D-02) |

Rehearsal takeaways (real, code-derived): redaction + fixture-candidate generation work; but the
**activity schema is unvalidated**, the **fixture comparison is anchored to one record fixture**,
and **zone-listing isn't a run() target** — logged as D-01/D-02/D-03.

## 7. Discrepancies
See [discrepancy-register.md](discrepancy-register.md). At parking time: **6 open** — 4 tooling
gaps found during rehearsal (D-01..D-04, code-derived) and 2 live-confirmation items (D-05, D-06,
PENDING the live run). No live-only discrepancies can exist until the live cycle runs.

## 8. Fixture candidates
None generated from live data (parked). The mock rehearsal can emit candidates but they are
synthetic and **not** for commit. Live candidates must pass [fixture-review-checklist.md](fixture-review-checklist.md)
before any commit.

## 9. Overall classification & release recommendation
- **Per-target classification:** all **PENDING LIVE RUN** (§5). The mock column in §6 is not a
  substitute.
- **Release recommendation:** **NOT YET DETERMINABLE — the live read-only trial cannot be
  recommended until the live cycle runs.** The decision framework and current (blocked) verdict
  live in [read-only-trial-readiness.md](read-only-trial-readiness.md).

## 10. Security review outcome
- **Mock rehearsal:** credential redaction verified by tests (`[REDACTED]`, structure/order
  preserved); no secrets persisted; sanitised sample only. ✅
- **Live payloads:** **PENDING** — the fixture-review checklist (credentials, internal addresses,
  account identifiers, usernames, API-key identifiers, sensitive metadata) must be signed off per
  candidate before any commit.
- **NS1 mutation:** none — read-only, GET-only, verified by route/service tests (no write path).

# Read-only operational trial readiness

Decides whether RADAR is ready for a **read-only operational trial** against RTÉ NS1, based on
the live validation cycle. RADAR is read-only in v1; "trial" means observing/explaining live NS1
steering, never modifying it.

## Current verdict

> **NOT READY — the live validation cycle has not been executed (parked, awaiting the dedicated
> read-only NS1 key).**
>
> A recommendation cannot be made from mock data. This verdict updates to one of the three
> recommendations below once the live cycle in
> [rte-live-validation-report.md](rte-live-validation-report.md) is complete and its discrepancies
> are dispositioned in [discrepancy-register.md](discrepancy-register.md).

## Recommendation scale
1. **Safe for read-only operational trial** — proceed.
2. **Safe with known limitations** — proceed, with documented caveats and guardrails.
3. **Not ready for operational trial** — do not proceed; blockers must be resolved first.

## Decision criteria
Assess after the live run:

| Criterion | Bar for "safe" | Bar for "safe with limitations" | Forces "not ready" |
|---|---|---|---|
| Primary live record (T3) schema+adapter | `compatible` / `compatible_with_warnings` | `partial` with understood cause | `incompatible` |
| Unsupported filters on watched records | none on live-steering paths | present but on non-critical records, clearly labelled partial | unsupported filter changes the *steering answer* undetected |
| Field-type mismatches on relied-upon fields | none | non-critical only | critical field mistyped (answers/filters) |
| ECS configuration (T3) | matches expectation (honoured) | present, nuance documented | ECS absent where RADAR assumes it |
| Activity-field mapping (T5, D-01) | confirmed | confirmed with minor gaps documented | mapping wrong/unconfirmable → actor/action mislabelled |
| Answer groups / feed-controlled metadata | detected & represented honestly | present, partially modelled, disclosed | silently mismodelled |
| Security review (per candidate) | all checklist items pass | pass with placeholders applied | any credential/PII would be exposed |
| Discrepancy register | no open **critical**/**high** on live-steering path | open medium/low with mitigations | open critical/high on the live-steering path |

## Guardrails that must hold in any trial (already true in v1)
- Read-only, GET-only to NS1; no write path exists (route/service tests enforce this).
- Live validation is gated (`NS1_VALIDATION_ENABLED`) and the NS1 key never reaches the browser
  or logs.
- No fixture candidate is committed without a signed
  [fixture-review-checklist.md](fixture-review-checklist.md).
- The three provenance tiers stay distinct: **predicted** steering, **observed** DNS, and
  **actual traffic** (still *telemetry not connected*) — a trial must not present predicted or
  observed data as delivered traffic.
- Any adapter change from confirmed live fields is narrowly scoped, regression-tested, and does
  not broaden semantics beyond what the payload proves.

## Blockers to clear before the live cycle can fully cover scope
- **D-02** (zone-listing not a run() target) and **D-03** (fixture comparison anchored to one
  fixture) limit T1/T4 coverage; both have narrow recommended fixes (deferred to their own
  commits). The zone (T2), records (T3/T4) and activity (T5) can be validated today.
- **D-01** (activity schema was a no-op) is now **partially resolved**: the T5 validation target
  actively verifies the container contract and reports per-field heuristic coverage (critical-field
  miss → `partial`), and the live poll rejects non-container payloads. Remaining pending-live work
  is to **lock** the normaliser field names against a confirmed live capture.

## Sign-off (to complete after the live run)
- Live cycle executed: ☐  ·  Discrepancies dispositioned: ☐  ·  Security review passed: ☐
- **Recommendation:** ☐ safe for trial  ☐ safe with limitations  ☐ not ready
- Approver: `__________`  ·  Date: `__________`

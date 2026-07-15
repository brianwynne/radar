# NS1 validation discrepancy register

Tracks divergences between live NS1 and RADAR's current assumptions. At parking time this holds
**code-derived tooling gaps** found during the mock rehearsal (D-01..D-04) and **live-confirmation
items** (D-05..D-06) that only the live cycle can resolve. Live-only discrepancies are added when
the live run executes — none are invented here.

Severity: **critical** (blocks a read-only trial) · **high** (materially wrong output) ·
**medium** (limited/edge impact) · **low** (cosmetic/robustness).
Status: **open** · **deferred** (fix scheduled as a separate commit) · **pending-live** (needs the
live payload) · **resolved**.

---

### D-01 — Activity schema/adapter validation is effectively a no-op
- **Endpoint/record:** `GET /v1/account/activity` (T5)
- **Live field/structure:** *(PENDING live)* — the real NS1 activity wire **field names/envelope**.
- **Original RADAR assumption:** `Ns1ActivityShape = z.unknown()` (wire.ts) and the activity
  normaliser (`ns1/activity.ts`) maps fields **heuristically** (e.g. `occurredAt ← timestamp|
  occurred_at|date|time|created_at`, `actor ← user|username|user_id|actor|api_key_name|
  api_key_id`). So schema compatibility for activity was trivially "compatible" and proved nothing.
- **Operational impact:** the Activity screen's field mapping (time/actor/action/resource) is
  unverified; wrong mapping could mislabel who/what/when.
- **RESOLVED (partial) — the no-op is fixed** without inventing NS1's schema:
  - `Ns1ActivityShape` now asserts the one contract RADAR relies on: the response is an
    **extractable container** (`array` | object) — a scalar/null now raises `NS1_INVALID_RESPONSE`
    loudly instead of silently yielding zero events. `passthrough()` keeps all raw fields.
  - The `activity` validation target has a dedicated `analyseActivity` (no longer `analyseGeneric`
    with `z.unknown()`): it reuses the exact `entriesOf` extraction, then reports **per-field
    heuristic coverage** over `normaliseActivity` — an unmapped **critical** field (`occurredAt`,
    `resourceKey`, `action`) → **partial**; an unmapped non-critical field → warning; a container
    with zero extractable entries → adapter-incompatible ("change detection would be blind").
  - So the T5 report now *proves* whether RADAR's heuristic actually works against the live payload.
- **STILL PENDING-LIVE:** confirm the exact wire field names/envelope from a real capture, then
  **lock** the normaliser mapping (replace the heuristic key-lists with the confirmed keys) and
  optionally narrow `Ns1ActivityShape` to the confirmed envelope. Do NOT lock before live confirms.
- **Severity:** high (for activity confidence) → **medium** (no-op removed; field-name lock outstanding).
  **Fixture update required:** yes (confirmed activity fixture). **Status:** partially-resolved;
  field-name lock pending-live.

### D-02 — "Zone listing" is not a run() target
- **Endpoint/record:** `GET /v1/zones` (T1)
- **Current RADAR assumption:** `ValidationService.run()` validates a zone **or** a record (+
  optional activity); it never validates the zones-list endpoint. `Ns1ZonesListShape =
  z.array(z.unknown())` is minimal.
- **Operational impact:** the required T1 target can't be exercised through the run API/UI; only
  a direct `analyse('zones', …)` call covers it (used in the rehearsal).
- **Severity:** medium. **Fixture update required:** possibly (confirmed zones-list shape).
  **Required code change:** add a `zones`/`listZones` path to `run()` (narrow, read-only).
  **Status:** deferred (separate commit; not in this parked chore).

### D-03 — Fixture comparison is anchored to a single record fixture
- **Endpoint/record:** any record other than `live.rte.ie/A` (observed on `vod.rte.ie/A` in the
  rehearsal).
- **Current RADAR assumption:** `analysis.ts` always diffs against `RECORD_LIVE_RTE_IE_A`. So a
  different record reports spurious `provisionalFixtureFields`/`liveOnlyFields` (rehearsal showed
  `filters[].config.threshold` as "live-only", `answers[].meta.ip_prefixes` as "provisional",
  etc.) that are just fixture-vs-fixture noise.
- **Operational impact:** fixture-comparison output for non-primary records is misleading (noise,
  not real divergence).
- **Severity:** medium. **Fixture update required:** no. **Required code change:** select the
  comparison fixture per endpoint/record (or compare structurally against the record's own prior
  snapshot). **Status:** deferred (separate commit).

### D-04 — Zone-endpoint analysis is schema-only
- **Endpoint/record:** `GET /v1/zones/rte.ie` (T2)
- **Current RADAR assumption:** the `zone` endpoint runs `analyseGeneric` (schema check only); it
  does not inventory the records within the zone (filters, meta, ECS).
- **Operational impact:** a zone-level validation gives limited assurance; per-record validation
  (T3/T4) is where the substance is.
- **Severity:** low. **Fixture update required:** no. **Required code change:** optionally expand
  zone analysis to sample its records. **Status:** deferred (optional).

### D-05 — Provisional NS1 field names are unconfirmed
- **Endpoint/record:** records + activity (all)
- **Current RADAR assumption:** fixture field names are **plausible guesses** — record `meta`
  keys (`up`, `weight`, `note`, `country`, `asn`, `ip_prefixes`), filter `config` keys (`N`,
  `remove_no_asn`, `remove_no_ip_prefixes`), and the activity field names in D-01.
- **Operational impact:** unknown until live; a mismatch surfaces as unknown/unexpected/missing
  fields or type mismatches in the live report.
- **Severity:** pending-live. **Fixture update required:** likely. **Required code change:** only
  where a confirmed live field is mismatched, narrowly. **Status:** pending-live.

### D-06 — Feed-controlled `meta.up` shape unconfirmed
- **Endpoint/record:** `live.rte.ie/A` (and any feed-driven answer)
- **Current RADAR assumption:** feed-controlled health is modelled as `meta.up = { feed: … }` and
  treated as "assumed up (no runtime feed state in v1)".
- **Operational impact:** if the live wire shape differs, feed-controlled detection and the
  "assumed up" narrative may be wrong.
- **Severity:** pending-live. **Fixture update required:** possibly. **Required code change:** only
  if live proves a different shape. **Status:** pending-live.

---

*Live-only discrepancies (fields/filters/structures seen only in the real payload) are appended
here as D-07+ when the live cycle runs.*

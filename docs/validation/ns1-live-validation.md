# NS1 live validation (read-only)

Before RADAR is trusted against real RTÉ NS1 data — and before new capabilities are layered
on — this tooling **validates** live (or mock) NS1 payloads against RADAR's runtime schemas,
the engine adapter, and the current synthetic fixtures, and reports exactly where they agree
or diverge. It is strictly **read-only**: it uses the existing read-only NS1 client, never
writes to NS1, never silently coerces incompatible live data into the synthetic model, and
persists only credential-redacted, structural samples.

## What it does
For a target (a zone, or a specific record, optionally the activity log) it:
1. Fetches via the **existing read-only NS1 client** (GET-only; no write method, no arbitrary
   URL, no caller-supplied key or payload).
2. **Preserves the complete raw response** in memory for checksums and comparison.
3. Runs three checks without coercion:
   - **Schema compatibility** — the live payload against RADAR's runtime wire schema.
   - **Adapter compatibility** — whether the engine can normalise + evaluate it.
   - **Fixture comparison** — structural diff against the synthetic fixtures (identifies
     provisional fixture fields absent from live, live-only fields, and type mismatches).
4. Inventories **supported vs unsupported filters**, **unknown metadata fields**, **unexpected
   fields**, **missing expected fields**, **field-type mismatches**, **answer-group** presence,
   **feed-controlled metadata** presence and **ECS** configuration — preserving answer order,
   filter-chain order, answer-group structure and unknown fields throughout.
5. Produces an **overall status**: `compatible`, `compatible_with_warnings`, `partial`
   (e.g. unsupported filter / missing non-critical field), `incompatible` (schema invalid or a
   critical field missing/mistyped), or `unavailable` (upstream fetch failed).

## Controlled live mode
Validating a **live** NS1 account requires `RADAR_MODE=live` **and** `NS1_VALIDATION_ENABLED=
true` — a deliberate gate so live NS1 is never queried by accident. Mock-mode validation is
always available. Neither mode can write to NS1.

## APIs
| Route | Permission | Notes |
|---|---|---|
| `POST /api/v1/validation/ns1/run` | `validation.run` | Body: `zone` (+ optional `domain`, `recordType`, `includeActivity`, `includeRaw`) only — strict allow-list. |
| `GET /api/v1/validation/ns1/results` | `ns1.detail.read` | Bounded history (no sanitised sample in the list). |
| `GET /api/v1/validation/ns1/results/:resultId` | `ns1.detail.read` | Sanitised sample only with `ns1.raw.read`. |
| `GET /api/v1/validation/ns1/unsupported-features` | `ns1.detail.read` | Aggregated unsupported filters + unknown metadata. |

Raw payloads (always **sanitised** / credential-redacted) are gated on `ns1.raw.read`.

## Persistence (migration `0004_ns1_validations`)
Bounded results only: metadata, compatibility status, warnings, field-mismatch summaries, the
unsupported-feature inventory, checksums and a **sanitised structural sample**. Never stored:
the NS1 API key, bearer tokens, full request headers, cookies, credentials or any unsanitised
secret. `sanitisedSample` is deep-redacted (`[REDACTED]`) with structure and order preserved.

## Sanitised fixture candidate
"Generate sanitised fixture candidate" produces a **downloadable draft only** — it is never
committed automatically. It is credential-redacted, preserves structural fidelity, carries
provenance metadata (source, mode, endpoint, checksum, retrieval time) and an explicit
`reviewRequired` list (unexpected fields, unknown metadata, unsupported filters, feed-controlled
metadata, answer groups, redacted fields). An operator must review it before it becomes a
source-controlled fixture.

## Frontend
`/validation/ns1` (`ns1.detail.read`) shows the source mode, a run form, and per-result
compatibility with supported/unsupported filters, unknown/unexpected/missing fields, type
mismatches, answer groups, feed-controlled metadata, ECS config, adapter warnings, the fixture
comparison, an exportable sanitised report, and (with `ns1.raw.read`) sanitised raw access and
the fixture-candidate action. A prominent notice states **"Validation is read-only. RADAR has
not modified NS1."**

## Out of scope
No NS1 writes, no caller-supplied URL/key/payload, no automatic fixture commit, no coercion of
incompatible live data into the synthetic model.

See [../ns1/assumptions.md](../ns1/assumptions.md) and [../ns1/developer-guide.md](../ns1/developer-guide.md).

# Stream Conformance & CDN Consistency

Standards-aware assurance that validates DASH/HLS/CMAF delivery and detects cross‑CDN
inconsistency — in particular the class of incident where one CDN serves a stale or
wrong‑variant object because of an **origin‑side variant / forwarded‑Host mismatch**, not a
stale CDN cache.

> **Repository note.** The feature brief assumed a "Go core". RADAR is in fact a **TypeScript
> monorepo** (`packages/radar-engine` pure core, `packages/radar-data` Postgres, `apps/api`
> Fastify, `apps/web` React). This feature is implemented in TypeScript. Pure evaluation logic
> lives in `@radar/engine`, preserving RADAR's core/connector separation.

## Status — staged delivery

This is a large, multi‑stage capability. **Stage 1 (the engine core) is implemented, built and
tested.** Later stages (persistence, probe worker, scheduler, REST API, React UI, external
validator) are scoped below with defined interfaces.

### Stage 1 — engine core (DONE, `packages/radar-engine/src/stream-assurance/`)

Pure, deterministic, dependency‑free, no I/O, no keys:

| Module | Responsibility |
|--------|----------------|
| `isobmff.ts` | **Bounded** ISO‑BMFF/CMAF box reader. Validates box sizes and nesting, 32/64‑bit sizes, `uuid` boxes; enforces depth and box‑count limits; treats over‑declared sizes as truncated; never allocates on attacker‑controlled lengths; retains byte offsets for evidence. Descends `stsd`/sample‑entries/`sinf`/`schi`. |
| `cenc.ts` | CENC/DRM **signalling** extraction (ISO/IEC 23001‑7): full `default_KID` as canonical UUID (no fixed offsets), `schm` scheme, IV size, `pssh` system IDs + v1 KIDs (data length only), plus `ftyp`/track metadata (`tkhd`/`mdhd`/`hdlr`/`frma`). **Never** reads/stores/exposes keys or licence data. |
| `dash.ts` | DRM + freshness extraction from an MPD (ContentProtection `default_KID`, DRM system IDs, `type`, `publishTime`, `minimumUpdatePeriod`). Narrow by design; a full ISO/IEC 23009‑1 structural validator replaces the internals behind this interface in a later stage. |
| `cdn-headers.ts` | Akamai (`X‑Cache`, `X‑Cache‑Remote`) and Fastly (`X‑Cache`, `X‑Served‑By`, `Age`) adapters → a common `{ edge, parent, fetchedFromOrigin, originIdentity, servedBy, age }`. Origin‑identity header names are configurable. |
| `rules.ts` | Versioned **rule catalogue** (data, not code) — rule IDs, severity, standard/section, concise **original** description + remediation. Plus the classification enum. No copyrighted standards text. |
| `classify.ts` | Cross‑CDN and DRM classification. Expected value resolved by priority **authoritative → reference → consensus** (consensus is informational only). Produces `Finding`s with rule ID, severity, likely layer, plain‑English explanation, remediation and evidence. |

**Incident detection.** When a CDN's KID differs from the reference **and** its edge *and*
parent both report cache MISS, the object came from origin — so it is classified
`ORIGIN_VARIANT_MISMATCH` (rule `SA‑CDN‑001`, likely layer `config` when the forwarded Host ≠
origin host), **not** `CDN_EDGE_STALE`. Remediation calls out aligning the forwarded Host with
the origin hostname. This exact scenario is covered by an automated test
(`test/stream-assurance/classify.test.ts`).

### Stage 2 — SSRF‑guarded connect‑to probe (DONE, `apps/api/src/stream-assurance/`, on branch `feature/stream-assurance`)

The connector‑execution layer that turns the engine into something that observes real endpoints:

| Module | Responsibility |
|--------|----------------|
| `ssrf.ts` | Target validation before any connection: rejects loopback / link‑local / cloud‑metadata / private ranges unless the endpoint is an explicitly‑approved **managed internal** endpoint AND policy permits it; optional host allowlist. Pure — no DNS, no sockets. |
| `probe.ts` | The **`curl --connect-to` equivalent**: fetches a public URL while dialling a chosen target host/IP. TLS verification stays ON and the cert is validated against the public hostname via **SNI**; only the TCP destination and the forwarded **Host** header are overridden. Strict timeout + max‑size bounds; never disables verification or mutates global DNS. |
| `observe.ts` | Validate (SSRF) → probe → parse with `@radar/engine` → build `EndpointObservation` → `classifyCrossCdn`. All standards/DRM/classification stays in the engine. |

Proven by an **end‑to‑end integration test** (`test/stream-assurance/observe.integration.test.ts`):
two mock "CDNs" backed by one origin that returns a different object per forwarded Host; the probe
fetches each, the engine extracts the real KIDs and the set is classified `ORIGIN_VARIANT_MISMATCH`
— reproducing the incident through real HTTP, plus an SSRF‑block test.

### Stage 3 — persistence + REST API + console page (DONE, on branch `feature/stream-assurance`)

The feature is now operable end‑to‑end from the console:

- **Persistence** (`radar-data`, migration `0011_stream_assurance`): `sa_profiles` (operator channel +
  endpoint config as jsonb — no secrets) and `sa_runs` (bounded per‑run snapshot: observations +
  findings). `PostgresStreamAssuranceRepository` with `pruneRuns` retention. (pg‑mem + migration‑count
  tests updated.)
- **Service** (`apps/api/src/stream-assurance/service.ts`): runs a profile through the SSRF‑guarded
  probe + engine classification and persists the snapshot. SSRF policy from env
  (`SA_ALLOW_MANAGED_INTERNAL`, `SA_ALLOW_HOSTS`) — secure by default.
- **REST API** (`routes/stream-assurance.ts`, RBAC + audit): `GET /rules`, `GET /profiles`,
  `GET /profiles/:id`, `GET /profiles/:id/latest`, `POST /profiles` (Engineer), `POST /profiles/:id/run`
  (Viewing Engineer, **audited**). NOC views (topology.summary.read).
- **Console** (`pages/StreamAssurance.tsx`, nav **Stream Assurance**): profile list, a **CDN comparison
  table** (endpoint · provider · KID · edge/parent cache + "from origin" · origin · Last‑Modified ·
  status, differing KID highlighted) and **standards findings** (severity, rule, plain‑English
  explanation + remediation). A viewing engineer gets a **Run now** action.

### Stage 4 — alert state machine + scheduler (DONE, on branch `feature/stream-assurance`)

Findings become durable, acknowledgeable, automatically‑monitored alerts:

- **Alert state machine** (`@radar/engine` `alert.ts`, pure): `observed → pending → active →
  acknowledged → resolved` with a configurable consecutive‑present activation threshold (critical
  rules activate faster but still need ≥2 occurrences — never a single transient failure) and a
  consecutive‑absent auto‑resolve; re‑opens a fresh incident on recurrence.
- **Durable alerts** (migration `0012_stream_assurance_alerts`): a `sa_alerts` row per finding
  identity (profile + endpoint + rule + classification), tracking state, occurrences, first/last seen
  and acknowledgement. `reconcileAlerts` on every run advances the lifecycle; `pruneAlerts` retention.
- **Scheduler** (`scheduler.ts`): runs enabled profiles on a normal cadence and supports a faster,
  **auto‑expiring event/key‑rotation mode** per profile (skipped by the normal tick while active).
  Enabled by `SA_SCHEDULER_ENABLED`; event mode is API‑triggered regardless.
- **API** (audited): `GET /alerts`, `POST /alerts/:id/ack`, `POST /alerts/:id/resolve`,
  `POST /profiles/:id/event-mode`. **Console**: an *Active alerts* list with lifecycle‑state badges +
  acknowledge/resolve actions, and an *Event mode* toggle (viewing engineer).

### Stage 5 — HLS validator + DASH↔HLS cross-protocol comparison (DONE, engine, on branch `feature/stream-assurance`)

Pure, tested engine additions (like Stage 1):

- **HLS parser** (`hls.ts`): master (variants, rendition groups, `INDEPENDENT-SEGMENTS`) and media
  (media/discontinuity sequence, target duration, `EXTINF`, `PROGRAM-DATE-TIME`, `EXT-X-MAP`,
  `EXT-X-KEY` signalling, `ENDLIST`) playlists, plus Low-Latency HLS tags (`PART-INF`,
  `SERVER-CONTROL`, parts, preload hints). A quote-aware attribute parser.
- **HLS validators** (`hls-validate.ts`): master conformance (missing `EXTM3U`, variant without
  `BANDWIDTH`/`CODECS`, duplicate variants, undefined rendition group → `SA-HLS-002`); media
  timeline + encryption signalling (segment over target duration, non-monotonic `PROGRAM-DATE-TIME`,
  VOD without `ENDLIST` → `SA-HLS-003`; `EXT-X-KEY` without URI / missing `KEYFORMAT` → `SA-HLS-004`).
  **Never retrieves a key** — only the signalling.
- **Cross-protocol** (`xproto.ts`): `compareDashHls` checks DASH↔HLS agree on encryption identity
  (KID via init segments, DRM systems via `KEYFORMAT`→system mapping → `SA-XDRM-001`), codec families
  and live/VOD mode (`SA-XDRM-002`).
- `withEndpoint()` adapts a manifest-level `SpecFinding` into a run `Finding`.

### Stage 6 — manifest-fetch integration (DONE, on branch `feature/stream-assurance`)

The Stage-5 validators now run inside a probe run:

- **`manifests.ts`**: fetches a profile's DASH MPD + HLS master/media via the SSRF-guarded connect-to
  probe (through the reference endpoint), parses + validates with `@radar/engine`
  (`validateDashFreshness`, `validateMaster`, `validateMedia`) and runs `compareDashHls`. Bounded
  fetches; never retrieves a key.
- **Profile config** gains optional `manifests: { dashMpdUrl, hlsMasterUrl, hlsMediaUrl }` (route
  schema validates them as URLs).
- **`service.run`** attaches the manifest SpecFindings to the reference endpoint (via `withEndpoint`),
  so DASH staleness (`SA-DASH-001`), HLS conformance (`SA-HLS-*`) and DASH↔HLS mismatches
  (`SA-XDRM-*`) join the run and drive the alert lifecycle — the same as the cross-CDN findings.
- Proven end-to-end: a mock CDN serving a stale dynamic MPD + a FairPlay HLS pair (vs Widevine DASH)
  yields `SA-DASH-001` + `SA-XDRM-001` in the run, through the real API.

### Stage 7 — CMAF / DRM init-segment inspector (DONE, on branch `feature/stream-assurance`)

The parsed init-segment metadata the engine already extracts is now captured per endpoint and
surfaced in the console:

- **`service.run`** attaches the bounded `InitSegmentInfo` (brands, tracks, CENC scheme +
  `default_KID` + IV size, PSSH **system IDs/names** + KID count + data length) to each stored
  observation. **Identifiers only — never keys, never raw bytes, never licence data.**
- **Console** (`pages/StreamAssurance.tsx`): an *Init segment / CMAF inspector* — one collapsible
  card per endpoint (protection scheme + KID prefix at a glance), expanding to brands, track
  codecs/handlers, the `tenc` protection line (scheme · full KID · IV size) and PSSH systems
  (Widevine/PlayReady/FairPlay etc. by system-ID), highlighting `tenc`/`pssh`. Collapsed by default.
- Covered by the API route test (observation carries `init`; `init.cenc.defaultKid === kid`; no
  `key` field) and the web page test (expanding reveals the CENC scheme + PSSH system).

### Stage 8 — per-CDN manifest comparison (DONE, on branch `feature/stream-assurance`)

Manifests are now fetched and validated through **every** endpoint, not just the reference, and the
parsed generations are cross-compared so a stale/wrong manifest on one CDN is caught:

- **Engine** (`manifest-consistency.ts`, pure): `compareManifestsAcrossCdns(manifests)` takes the same
  manifest as parsed via each CDN and flags, against the reference, `SA-XCDN-001` (`DRM_KID_MISMATCH`,
  critical — one CDN advertises a different `default_KID`, i.e. a different key generation),
  `SA-XCDN-002` (`REPRESENTATION_DRIFT` — a differing DASH/HLS bitrate ladder) and `SA-XCDN-003`
  (`MANIFEST_STALE` — a live MPD `publishTime` skewed beyond tolerance, one CDN out of step). DASH
  extraction now also captures the `Representation@bandwidth` ladder.
- **Connector** (`manifests.ts`): `observeManifests` returns the parsed `{ dash, hlsMaster }` alongside
  its per-endpoint SpecFindings; **`service.run`** fetches via every endpoint (same public URL,
  per-CDN connect-to), attributes each endpoint's validation findings to it, then runs the cross-CDN
  comparison. The resulting `Finding`s join the run and drive the alert lifecycle like any other.
- Proven end-to-end: a two-CDN run where one edge serves a drifted MPD generation yields
  `SA-XCDN-001` attributed to the lagging CDN, through the real API — with the freshness rule staying
  quiet (both published at `now`).

### Later stages (scoped, not yet built)

Defined interfaces exist or are trivial to add on top of the engine + probe + persistence:

- **Media-fragment timeline sampling** — sample a recent media fragment per rendition and compare
  `tfdt`/`baseMediaDecodeTime` timelines across CDNs (gap/overlap detection).
- **Full‑conformance mode** — deeper manifest/ladder/fragment validation, on demand + after config
  change; optional self‑hosted DASH‑IF Conformance Tool adapter.
- **REST API** (Fastify, existing RBAC + audit) — profiles/endpoints CRUD, trigger run, event
  mode, latest status, run/observation/comparison/finding reads, ack/resolve, rule catalogue.
- **React UI history** — History charts (finding/alert trend over time) in the existing RADAR
  visual language. (Overview matrix, CDN comparison, standards findings and the CMAF/DRM
  metadata inspector are built; a full **box-tree** viewer — raw box offsets/sizes with
  `tfdt`/`senc` — remains.)
- **HLS validator** — master/media playlist + LL‑HLS + `EXT‑X‑KEY` signalling (no key retrieval),
  and DASH↔HLS cross‑protocol comparison.
- **External validator adapter** — optional, disabled by default, self‑hosted DASH‑IF
  Conformance Tool only; never sends private URLs to a public validator; fails independently.

## Security controls (Stage 1)

- **No key material** ever read, stored, logged or displayed. KIDs and PSSH **system IDs** are
  identifiers and may be shown; `pssh` licence data is summarised by length only.
- Bounded parsing (size/depth/count limits) — malformed or hostile files cannot exhaust memory.
- SSRF controls are specified for the probe worker (later stage) and must gate any fetch.

## Local commands

```bash
# Standalone Node 22 is required for vitest (system node is 18).
cd packages/radar-engine
npm run build            # tsc
npx vitest run test/stream-assurance   # the Stream Assurance engine tests
npx vitest run           # all engine tests (existing + new)
```

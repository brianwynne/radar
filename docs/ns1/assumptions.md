# NS1 Connect — API Assumptions Register

Authoritative project-local spec: **[developer-guide.md](developer-guide.md)** (the RADAR
NS1 Developer Guide, checked in from RTÉ). Per its final instruction, RADAR treats that
guide plus checked-in fixtures as *the* NS1 specification and does not scrape the IBM
site. This register records what is now **verified** by the guide vs still **assumed**
pending a captured fixture, and where each is isolated behind an interface.

## Documentation access (unchanged)

The IBM developer portal / API Hub is JavaScript-rendered and **returns HTTP 403 to
automated fetches** — it cannot be read by tooling. Grounding therefore comes from (a) the
RADAR NS1 Developer Guide, and (b) the official NS1 Connect Go SDK (`github.com/ns1/ns1-go`,
read via `gh`), the authoritative client for the same API. **No wire field name is
invented**; where a JSON field/config name is not yet confirmed it is marked
`FIXTURE-PENDING` and the value is preserved raw (`.passthrough()`), never guessed.

## Verified — API fundamentals (guide §3–4, confirmed by the SDK)

| Item | Value | Source |
|---|---|---|
| Base URL | `https://api.nsone.net/v1` | guide §3.1, SDK `rest/client.go` |
| Auth header | `X-NSONE-Key: <key>` (HTTPS only, never logged) | guide §3.2/§22, SDK |
| Method convention | GET=retrieve, **PUT=create, POST=update, DELETE=delete** — RADAR v1 rejects PUT/POST/DELETE against NS1 | guide §3.3 |
| List zones | `GET /v1/zones` | guide §4.1, SDK |
| Get zone (complete JSON, incl. Filter Chain) | `GET /v1/zones/{zoneFQDN}` | guide §4.2, SDK |
| Get record | `GET /v1/zones/{zone}/{domain}/{type}` | guide §4.3, SDK |
| Activity log | `GET /v1/account/activity` (needs the view-activity permission) | guide §4.4 |
| BIND export | **omits the Filter Chain — not sufficient for RADAR**; use complete JSON zone retrieval | guide §4.5 |
| Record fields | `id, zone, domain, type, ttl, use_client_subnet, answers[], filters[], regions, meta` | SDK `rest/model/dns/record.go` |
| Answer fields | `id, answer[] (rdata), meta, region, feeds[]` — **do not assume a stable id exists**; generate a deterministic RADAR id from value+group+position, retain original index | SDK; guide §7 |
| Filter | `{ "filter": <type>, "disabled": bool, "config": {…} }` (ordered array = Filter Chain) | SDK `rest/model/filter/filter.go` |
| Meta fields | `up, weight, priority, country, georegion, asn, ip_prefixes, note, …`; a value may be a feed pointer `{ "feed": <id> }` | SDK `rest/model/data/meta.go` |

## FIXTURE-PENDING — endpoints behind interfaces (guide §5)

Monitoring jobs, data sources, feeds, notifier lists, filter-metadata definitions, and
detailed account permissions: exact paths/schemas unconfirmed. Modelled as **optional**
methods on the read client, disabled until a captured response verifies them.

**Activity log fields (`GET /v1/account/activity`) — FIXTURE-PENDING.** The endpoint is
verified (§4.4) but its exact wire fields are not. `apps/api/src/ns1/activity.ts`
normalises only plausible, confirmed-shaped fields (timestamp, actor/API-key **identity**,
action, resource type/key, outcome, safe detail) by trying candidate key names; it invents
no semantics. The original entry is preserved under each item's `raw`, with credential-like
keys stripped. The response carries a `mappingNote` labelling the mapping fixture-derived.
Tighten the mapping once a real (sanitised) activity capture is checked in.

## ECS / identity (guide §9 — verified; engine matches)

- Address selection: ECS enabled on the record **and** resolver sends ECS → filters use
  the client subnet; ECS disabled on the record → filters use the **resolver IP even if
  ECS is sent**. RADAR surfaces `identity_source = ecs | resolver`. (`deriveIdentity`
  implements exactly this via `use_client_subnet`.)
- Filters documented as using ECS: Geofence Country/Regional, Geotarget
  Country/Latlong/Regional, Netfence ASN, Netfence Prefix, Weighted **Sticky** Shuffle,
  Pulsar filters. (Plain Weighted Shuffle is not in that list.)
- Confidence: **High** (ECS present+enabled) · **Medium** (ISP recursive resolver likely
  colocated) · **Low** (public/corporate resolver, no ECS) · **Unknown** (insufficient
  info). A RADAR explanation feature, not an NS1 field.

## Filter semantics — verified vs assumed

| Filter | Status | Notes |
|---|---|---|
| `up` | **Verified** behaviour; **missing-value handling FIXTURE-PENDING** | Eliminates down answers. Distinguish up / down / missing / feed-unresolved / simulation-override. If missing-value behaviour is unconfirmed, **mark evaluation partial rather than guess** (guide §10). |
| `netfence_asn` | **Verified** | Retain matching-tagged + untagged; remove tagged-non-matching; if no match, untagged remain. A "remove untagged on match" option exists — **config field name FIXTURE-PENDING**. Not a security control (NS1 tries to return ≥1 answer). (guide §11) |
| `netfence_prefix` | **Verified**; needs **IPv6** | Same tagged/untagged model over IP prefixes (up to 1000/answer), against the ECS/resolver-selected address. Use a standards-compliant IPv4/**IPv6** CIDR library. Current engine is IPv4-only — IPv6 is a known gap. (guide §12) |
| `geofence_country` | **Verified** (eliminate) | Removes non-matching; `remove_no_location`-style option. Geofence ≠ Geotarget. (guide §13) |
| `geotarget_country` | **Verified** (reorder) | Reorders by match; removes nothing. Regional/latlong (proximity) **not implemented** → unsupported→partial. (guide §13) |
| `weighted_shuffle` | **Verified** | Probabilistic order by weight; with `select_first_n=1`, top-answer probability = relative weight (70/20/10 → 70/20/10) under the stated conditions. Never a guaranteed traffic share. Show **expected** probability, not the specific historical ordering. Seeded simulation optional. (guide §14) |
| `select_first_n` | **Verified** | Keep first N (read N from config; default typically 1). (guide §15) |
| `priority`, `cost`, `shed_load`, `pulsar_*` | **Implement only if in RTÉ fixtures** | `priority` semantics (sort vs sift) are config-dependent — **the current engine implements a top-tier sift as ASSUMED (medium confidence)**, pending a fixture. `cost` is display-only (RTÉ: not an optimisation factor). Unknown/unsupported → preserve raw + mark partial. (guide §17) |
| **answer groups** / `select_first_group` | **Not yet modelled** | NS1 supports groups; filters can operate on groups (e.g. Geotarget Regional → Select First Group → Weighted Shuffle → Select First N). The engine does not yet model groups → any group filter is unsupported→partial. Planned. (guide §16) |

Any filter type not in the engine registry is UNSUPPORTED: pass answers through, mark the
step `supported=false`, set the result incomplete, and warn (guide §2.8, §17).

## Metadata provenance (guide §18)

Each metadata value must show its source classification: static/manual ·
monitor-controlled · third-party-feed-controlled · pulsar-controlled · unknown — plus
source/feed/monitor ids and last update where available. The UI must never imply a
feed-controlled value is static. The feed pointer `{ feed: <id> }` is grounded; the
monitor/source/feed *endpoints* are FIXTURE-PENDING (§5).

## Raw preservation, validation, client (guide §6, §22–24)

- Store raw + canonical + `raw_checksum` (+ optional `structural_checksum`); canonical
  sorts keys recursively and preserves filter/answer order; never alter the raw snapshot.
- Wire validation: minimal outer schema with **`.passthrough()`** (Zod or equivalent) —
  validate only fields a screen needs, preserve unknowns, broaden types only after a
  fixture exists.
- NS1 read client: GET-only, `X-NSONE-Key`, short timeout (`NS1_REQUEST_TIMEOUT_MS`,
  default 5000), bounded retry with jitter for transient GET failures only, redact the
  key, encode path components, **no method accepting an arbitrary URL**, short in-memory
  cache (`NS1_CACHE_TTL_SECONDS`, default 30, never authoritative).

## Deltas to apply to the engine (tracked)

1. Reconcile the result contract to guide §8.1/§25 (`traces`, `eligibleAnswerIds`,
   `complete`, `stoppedAtFilterIndex`, top-level `explanation`, `behaviour` per step,
   `confidence` gains `unknown`).
2. Add the steering **explanation** string (human-readable narrative).
3. `up`: five-state handling; feed-unresolved → warning/partial.
4. `netfence_*`: `remove_untagged_on_match` option; IPv6 prefixes.
5. Answer groups + `select_first_group`.
6. Enrich the fixture (feed-controlled value, an answer group, a prefix filter) and add
   guide §28 scenarios 1–6 + §29 contract tests.
7. Platform mapping via a RADAR-owned answer→platform table (guide §27), not only
   `meta.note`.

## Tier-2 DNS observation — resolver vs on-net (assumption)

RADAR verifies predicted steering by actively observing DNS, but a **resolver observation is
not the same as being on the ISP's network**, and this bounds every claim:

- **DNS steering (case 1)** — NS1 (authoritative) sees the recursive resolver's IP or its
  **EDNS Client Subnet (ECS)**. Querying via an ISP resolver reproduces a subscriber's answer
  **only if ECS is forwarded with a customer-representative prefix**; many resolvers strip or
  truncate ECS, in which case NS1 sees only the resolver's egress IP. RADAR records
  `ecsRequested` / `ecsHonoured` and never implies ECS was honoured unless the response
  confirms a scope (OPT scope-prefix-length > 0).
- **Traffic steering (case 2)** — once the client connects, the CDN sees its **real source
  IP**, so POP/edge selection, peering, cache behaviour and QoE behave as the *tester's* ISP,
  not the target ISP. RADAR therefore **cannot** infer traffic behaviour from DNS and keeps
  "Actual traffic" as *Telemetry not connected*.

Consequences encoded in RADAR: a **confidence** grade on every observation (high/medium/low/
unknown), no assertion of match/mismatch at low/unknown confidence, and a single observation
treated as one **sample** (never proof of the Weighted-Shuffle distribution). Configured ISP
resolver addresses and ECS subnets are **RADAR-owned placeholders** (RFC 5737) until RTÉ
supplies confirmed endpoints — RADAR never invents real resolver IPs. See
[../architecture/dns-observation.md](../architecture/dns-observation.md).

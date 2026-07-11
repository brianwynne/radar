# NS1 Connect — API Assumptions Register

RADAR must not invent NS1 fields, paths or semantics (brief §20.4, §9). This register
records exactly what is **grounded** vs **assumed**, with a confidence level and where
each is isolated behind an interface.

## Documentation access

The IBM developer portal (`developer.ibm.com/apis/catalog/ns1--ibm-ns1-connect-api/`
and `ibm.com/docs/en/ns1-connect`) **returns HTTP 403 to automated fetches** on every
path tried (catalog root, `/Introduction`, docs site — it requires an interactive
browser). It could not be read by tooling.

**Mitigation:** the integration is grounded on the **official NS1 Connect Go SDK**
(`github.com/ns1/ns1-go`, tag inferred `v2.18.0`), the authoritative client for the
same API, read via `gh api`. Object shapes, field names, the filter-chain structure and
endpoint paths below are taken from the SDK source, not invented. Runtime filter
*semantics* (how each filter matches) are RADAR's interpretation and are flagged
`ASSUMED` pending confirmation against the IBM docs — each is isolated behind the single
filter registry in `packages/domain/src/engine.ts`.

## Grounded (from the SDK — high confidence)

| Item | Value | SDK source |
|---|---|---|
| Base URL | `https://api.nsone.net/v1/` | `rest/client.go` (`defaultEndpoint`) |
| Auth header | `X-NSONE-Key: <key>` | `rest/client.go` (`headerAuth`) |
| List zones | `GET /v1/zones` | `rest/zone.go` |
| Get zone (+ records list) | `GET /v1/zones/{zone}` | `rest/zone.go` |
| Get record | `GET /v1/zones/{zone}/{domain}/{type}` | `rest/record.go` |
| Record fields | `id, zone, domain, type, ttl, use_client_subnet, answers[], filters[], regions, meta` | `rest/model/dns/record.go` |
| Answer fields | `id, answer[] (rdata), meta, region, feeds[]` | `rest/model/dns/answer.go` |
| Filter fields | `{ "filter": <type>, "disabled": bool, "config": {…} }` (ordered array = Filter Chain) | `rest/model/filter/filter.go` |
| Meta fields | `up, weight, priority, country, georegion, asn, ip_prefixes, note, connections, requests, loadavg, pulsar, latitude, longitude, us_state, ca_province, cost, low_watermark, high_watermark, subdivisions, additional_metadata` | `rest/model/data/meta.go` |
| Feed pointer | a meta value may be `{ "feed": <id> }` | `rest/model/data/meta.go` |
| Filter type identifiers | `up, geotarget_country, geotarget_regional, geotarget_latlong, geofence_country, geofence_regional, netfence_asn, netfence_prefix, weighted_shuffle, select_first_n, priority, shuffle, sticky, sticky_region, weighted_sticky, ipv4_prefix_shuffle, shed_load` | `rest/model/filter/filter.go` |
| `select_first_n` config | `{ "N": <int> }` | `rest/model/filter/filter.go` |

**Unknown/extra fields are preserved** (principle 5.3): all NS1 types in
`packages/domain/src/types.ts` carry index signatures; the raw JSON is stored verbatim
in Postgres `jsonb` (snapshots) and never discarded.

## ASSUMED — filter runtime semantics (verify against IBM docs)

RADAR implements the RTÉ-likely subset only. Each is RADAR's documented interpretation;
confidence and the exact rule are below. **Any filter not in this list is UNSUPPORTED:**
the engine passes answers through untouched, marks the step `supported=false`, sets
`certain=false`, and raises a partial-evaluation warning (principle 5.4).

| Filter | RADAR interpretation | Confidence |
|---|---|---|
| `up` | Remove answers whose `meta.up` is boolean-false (or health-overridden down). Feed-driven `up` is assumed up in v1 (no runtime feed state). | Medium |
| `netfence_asn` | Keep answers whose `meta.asn` contains the request ASN **or** carry no `asn` meta (global). Remove answers with a non-matching ASN set. No ASN → not applied (low confidence). | **Assumed** — verify allow-list semantics + no-meta handling |
| `netfence_prefix` | Keep answers whose `meta.ip_prefixes` (IPv4 CIDR) contain the client/ECS prefix, or carry no prefix meta. IPv6 not evaluated. | **Assumed** — verify |
| `geotarget_country` | Reorder only (no removal): answers matching `meta.country` prioritised ahead of others. | **Assumed** — verify sort vs group |
| `geofence_country` | Remove answers not matching request country; `config.remove_no_location` controls whether no-country answers are dropped. | **Assumed** — verify |
| `priority` | Keep the lowest-priority-number tier that has answers; higher numbers become standby/failover. Missing `priority` = least preferred. | **Assumed** — verify tier/failover rule |
| `weighted_shuffle` | Probabilistic ordering by `meta.weight` (default 1). RADAR reports **expected** shares `weight/Σweight`, explicitly labelled probabilistic — never a traffic guarantee. Display order is highest-weight-first; actual order is random per resolution. | High (probabilistic label), Medium (exact algorithm) |
| `select_first_n` | Keep the first `config.N` answers (default 1); the rest are removed. | High |

## ECS vs resolver (brief §8)

- Whether NS1 honours EDNS Client Subnet is governed by the record field
  `use_client_subnet` (grounded). RADAR derives identity accordingly: ECS honoured →
  evaluate the ECS subnet (high confidence); `use_client_subnet=false` or no ECS →
  evaluate the resolver IP, and RADAR states that country/ASN then describe the
  **resolver**, not necessarily the viewer.
- Country/ASN/network/prefix *derivation from an address* is **out of scope for v1** and
  supplied by the scenario (or override). A geo/ASN resolution adapter (MaxMind / NS1
  Pulsar / RIR data) replaces the supplied values later — isolated behind the scenario
  input. Flagged so no false precision is claimed.

## Out of scope for v1 (explicitly)

- No NS1 write operations of any kind (principle 5.1). The client implements GET only;
  no write-capable credential exists.
- Monitors/feeds (`/v1/monitoring/jobs`, `/v1/data/feeds`) are read-later; v1 treats
  feed-driven meta as "assumed up / default weight" and says so.
- `regions` answer-grouping is captured in the raw/normalised model but region-level
  meta evaluation is deferred (flagged where a record uses it).

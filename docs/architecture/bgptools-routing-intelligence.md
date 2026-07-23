# bgp.tools Routing Intelligence

External, independent BGP visibility for RADAR — evidence, warnings and a routing-integrity safety
signal that complements CloudVision (internal router/BGP state), Noction (traffic), NS1 (DNS
steering) and CDN telemetry. **Read-only.** RADAR never modifies BGP and never changes NS1 policy;
a routing-integrity signal may *qualify or inhibit* a recommendation but can never independently
trigger a steering change.

## Scope decision (v1 — documented-core only)

bgp.tools' **documented** machine-readable surface is limited to bulk exports:

| Source | What it gives | Notes |
|--------|---------------|-------|
| `table.jsonl` / `table.txt` | every prefix each AS originates, with a **visibility hit count** | cache ≥ 2 h; do not fetch more than every 30 min |
| `whois.bgp.tools:43` (+ bulk) | IP/prefix → origin ASN, name, allocation | no auth |
| `asns.csv` | ASN → name / classification | 24 h cache |
| `tags/{tag}.csv` | tagged prefix sets | — |

There are **no documented** bgp.tools webhooks, Prometheus endpoint, RPKI API, upstream API, or
AS-path / route-leak API. Per RADAR's anti-fabrication rule and the integration brief, v1 therefore
implements **only the signals the documented data supports** and does **not** invent endpoints for
the rest:

**In scope (documented):** prefix visibility ratio, prefix withdrawal, observed vs expected origin
ASN, unexpected-origin / hijack detection, MOAS, observation counts, first/last seen, source
confidence, staleness → integrity state.

**Out of scope for v1 (no documented source):** RPKI valid/invalid/expiry, upstream add/remove,
AS-path change, route-leak suspicion, Peerlock, single-upstream/Tier-1 dependency, webhook and
Prometheus ingestion. These remain modelled behind the client interface and can be wired if/when an
account-specific source is provided.

`User-Agent`: bgp.tools blocks default/generic agents. Live mode requires an identifying
`BGPTOOLS_USER_AGENT` of the form `RADAR bgp.tools - contact@rte.ie` (validated to contain a contact
email). HTML scraping is prohibited and never used.

## Three-layer model (traceable conclusions)

The connector keeps three layers separate so an operator can see exactly how a verdict was reached:

1. **`RawRoutingObservation`** — the provider's report for a prefix (origin ASN(s) + hit counts),
   unmodified.
2. **`NormalizedRoutingSignal`** — RADAR's derived signals: `observedOriginAsn`, `originAsExpected`,
   `prefixWithdrawn`, `unexpectedOrigin`, `moas`, `prefixVisibilityRatio`, `observationCount`,
   `first/lastObservedAt`, `sourceConfidence`, `stale`.
3. **`RoutingIntegrityAssessment`** — the verdict (`healthy` / `degraded` / `critical` / `unknown`)
   plus human-readable `reasons`, each mapping to a signal field.

## Assessment rules (deterministic)

Evaluated per prefix, in precedence order:

- **unknown** — observation older than the freshness window (`maxAgeSeconds`); integrity cannot be
  asserted, so preserve state / avoid aggressive automation.
- **critical** — prefix withdrawn (no origin); **or** the expected origin is absent while another
  ASN announces the prefix (hijack / takeover); **or** visibility below the critical ratio.
- **degraded** — visibility between the critical and warning ratios (partial visibility loss);
  **or** MOAS (expected origin present but a foreign origin also announces the prefix).
- **healthy** — sole expected origin at or above the warning-ratio visibility.

Overall estate state is the **worst** per-prefix state (safety-first: `critical > degraded >
unknown > healthy`), alongside per-state counts.

## Configuration (`BGPTOOLS_*`)

`ENABLED`, `MODE` (`mock` | `live`), `TABLE_URL`, `USER_AGENT`, `TOKEN`, `MONITORED_FILE`
(JSON `MonitoredPrefix[]` — prefix, family, `expectedOriginAsn`), `FULL_VISIBILITY_HITS`,
`VISIBILITY_WARN_RATIO`, `VISIBILITY_CRITICAL_RATIO`, `MAX_AGE_SECONDS`, `POLL_INTERVAL_SECONDS`
(≥ 1800, honouring the table cache guidance), `RETENTION_DAYS`, `TIMEOUT_SECONDS`, `VERIFY_TLS`,
`MOCK_SCENARIO` (dev demo).

## Security assumptions

- **Read-only, no write path.** The client interface exposes only `fetchObservations` / `ping`.
- The API token is sourced from `/run/secrets/bgptools_token` then `BGPTOOLS_TOKEN`, held in memory
  only, **never logged and never returned to the browser** (it will be stored AES-256-GCM encrypted
  in `connector_settings` via the shared `secret-box`, like the other connectors — slice 2).
- Live mode **fails closed**: no identifying User-Agent → refuses to start live.
- Mock mode needs no credentials and is clearly labelled `MOCK / SYNTHETIC` in provenance.

## Failure modes

- **Stale data** (table older than `MAX_AGE_SECONDS`) → prefix assessed `unknown`, snapshot warning.
- **Prefix not in the table** → treated as withdrawn (`critical`), never silently dropped.
- **No monitored prefixes configured** → overall `unknown` with a warning (never a false healthy).
- **Provider unreachable** (slice 2) → last-good snapshot retained, connector error surfaced; the
  assessment goes `unknown` once data passes the freshness window.

## Roadmap (subsequent slices)

1. ✅ **Foundation** — types, config, pure normalise/assess engine, mock provider + fixtures, tests.
2. Documented ingestion — `table.jsonl`/whois HTTP client (User-Agent, cache, rate-limit), poller
   (idempotent, deduped), incident grouping + lifecycle, migration `0006`, `@radar/data` repos,
   connection routes + **Integrations** page section, RBAC tests.
3. **Routing Intelligence** console — overview, prefix visibility matrix, incident feed, ASN/prefix
   detail drawer, visibility timeline (all documented-signal-driven).
4. Safety gate — wire the integrity assessment into the recommendation path as an *inhibitor only*,
   with the inhibited-action evidence panel + audit.

## Fixtures (dev / demo / tests)

Clearly synthetic (RFC 5737 / RFC 3849 documentation prefixes, RFC 5398 private-use hijacker ASN):
`healthy`, `partial_visibility_loss`, `full_withdrawal`, `unexpected_origin`, `moas_partial_hijack`,
`recovery`. Exposed via a **dev-only** demo scenario toggle (slice 2/3).

# Network-path telemetry — architecture

RADAR reports read-only utilisation for the PNI / INEX / transit paths so operators can see
how close each preferred path is to its configured capacity. Telemetry is **informational
only**: it never triggers an NS1 write and never changes persisted steering state. A future
deterministic steering-automation layer may *consume* this signal, but this commit is
visibility-only.

## Adapter boundary
The RADAR domain and UI depend only on `NetworkPathTelemetryClient` (returns fully-classified
`NetworkPathSample`s) — never on Prometheus (or any backend) query syntax. Three
implementations:

| Client | Behaviour |
|---|---|
| `DisabledNetworkPathTelemetryClient` | Reports configured paths as `telemetry_not_connected` (no observed value). |
| `MockNetworkPathTelemetryClient` | Deterministic, clearly-synthetic values (MOCK / SYNTHETIC). |
| `PrometheusNetworkPathTelemetryClient` | Read-only Prometheus instant queries. |

All three are wrapped by `CachingTelemetryClient` (short-lived in-memory cache; latest value
only). The factory `createTelemetryClient(config)` selects by mode.

## Path / interface mapping
`apps/api/src/telemetry/paths.ts` is the ONE place a logical path is bound to an interface,
capacity and thresholds. Browser input never contributes to it. Each mapping defines: RADAR
path id, display name, `PathType`, interface/link identity, configured capacity (bps),
configured target %, warning %, critical %, and the primary `direction`. Display names match
the Live Steering preferred-path labels (`Eir PNI`, `Virgin / Liberty PNI`, `INEX`,
`Transit`) so the UI can join them.

## Prometheus query model
`PROMETHEUS_QUERY_PATH_UTILISATION` is a RADAR-owned instant-query template with `$INTERFACE`
and (optional) `$DIRECTION` placeholders, substituted **server-side** from the mapping —
there is no user-supplied query. RADAR issues read-only `GET /api/v1/query` requests
(bounded timeout, bounded retry-with-jitter for transient failures), validates the
instant-vector response shape, and treats the scalar as a rate in bps. Capacity comes from
RADAR config, not Prometheus. A per-path source failure yields an `unavailable` sample (never
an invented value), so the API still lists every configured path.

## Configured vs observed
Configured capacity/target/thresholds (RADAR-owned) are kept strictly separate from observed
rates/utilisation (from the source). `utilisationPercent = observedRate / configuredCapacity`
— and is `null` (→ `unavailable`) for a missing rate or a non-positive capacity (never
divides by zero).

## Freshness, stale & status
`NETWORK_TELEMETRY_STALE_AFTER_SECONDS` defines the freshness window. Status is one of:
`healthy` (≤ target), `above_target` (> target), `warning` (≥ warning), `critical`
(≥ critical), `stale` (value older than the window — last value shown, flagged),
`unavailable` (enabled but no fresh value), `telemetry_not_connected` (disabled).

## Thresholds
Target 70%; warning 80%; critical 90% (warning/critical overridable via
`NETWORK_TELEMETRY_WARNING_PERCENT` / `_CRITICAL_PERCENT`; critical must be ≥ warning).

## Persistence
None. Only the latest observed value is cached in memory for
`NETWORK_TELEMETRY_CACHE_TTL_SECONDS`. No high-frequency telemetry is written to PostgreSQL —
historical telemetry stays with the source monitoring platform. RADAR remains stateless apart
from its existing PostgreSQL data.

## Security
- Read-only HTTP GET only; HTTPS required outside development.
- Prometheus auth is **generic** (optional bearer or basic) and read only from a mounted
  secret (`/run/secrets/prometheus_bearer_token` or `/run/secrets/prometheus_basic_auth`) —
  never from env, never logged, never returned by the API.
- No cloud-specific SDK. Errors are mapped to safe generic codes with no upstream detail.
- The API never returns the source URL, the query, or auth headers.

## Visibility-only scope & future use
Telemetry does not, in this commit, alter NS1 steering, capture snapshots, or write to any
store. A later deterministic steering-automation component could consume `NetworkPathSample`
(e.g. to prefer a path under its target), but that decision layer is explicitly out of scope
here.

See [../api/network-telemetry.md](../api/network-telemetry.md) and
[../frontend/live-steering.md](../frontend/live-steering.md).

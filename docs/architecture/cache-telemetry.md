# Cache-pool / cache-node / origin telemetry — architecture

RADAR reports read-only utilisation and health for the Réalta **cache pools**, individual
**cache nodes**, and the **origin**, so operators can see delivery headroom alongside the
DNS steering picture. Same portable-adapter pattern as the network-path telemetry. It is
**informational only**: RADAR never writes to NS1 or Cloudflare and never changes persisted
steering state. A future deterministic steering-automation layer may *consume* this signal;
that decision layer is out of scope here.

## Responsibility boundary
- **NS1** selects the delivery platform (Réalta / Fastly / …).
- **Cloudflare** selects the Réalta **origin pool** — RADAR does not, and cannot, say which
  pool a given viewer lands on.
- **RADAR observes** pool and origin telemetry. It **does not yet control** Cloudflare or NS1.

The UI states this wherever pool/origin telemetry appears.

## Adapter boundary
The domain/UI depend only on `CacheTelemetryClient` (returns fully-classified
`CachePoolSample` / `CacheNodeSample` / `OriginSample`). Implementations:

| Client | Behaviour |
|---|---|
| `DisabledCacheTelemetryClient` | Configured pools/nodes/origin as `telemetry_not_connected`. |
| `MockCacheTelemetryClient` | Deterministic, clearly-synthetic values (healthy→critical, plus stale/unavailable). |
| `PrometheusCacheTelemetryClient` | Read-only Prometheus instant queries per metric. |

All wrapped by `CachingCacheTelemetryClient` (short-lived in-memory cache per collection;
latest value only). Factory: `createCacheTelemetryClient(config)`.

## Configured context (manually maintained — never observed)
`apps/api/src/telemetry/pools.ts` is the ONE place pools/nodes/origin are defined:
- **Donnybrook** — 4 caches total, ~80 Gb/s practical (CPU-bound) each, ~320 Gb/s aggregate,
  modelled as **two pools of two caches** (2 × 160 Gb/s) to match the topology's Donnybrook
  Pool 1/2.
- **External Pool 1** — 4 caches, ~700 Gb/s outbound.
- **External Pool 2** — 4 caches, ~700 Gb/s outbound.

Node capacity = pool capacity / node count. These are badged CONFIGURED / manually
maintained; they are never presented as observed telemetry.

## Prometheus query model
RADAR-owned instant-query templates with `$POOL` / `$NODE` placeholders substituted
**server-side** from the central config — no user-supplied query. Each metric is an
independent GET instant query (bounded timeout + retry-with-jitter). `PROMETHEUS_QUERY_POOL_
THROUGHPUT` is the anchor; a missing optional template means that metric is simply not
observed (never fabricated). A per-target hard failure yields an `unavailable` sample so the
API still lists every configured pool/node. The single Prometheus connection + generic
bearer/basic auth (from a mounted secret) are shared with the network-path telemetry.

## Configured vs observed, headroom, thresholds
- Configured capacity / node count / thresholds (RADAR-owned) are separate from observed
  throughput / CPU / memory / hit-ratio / request-rate (from the source).
- **Headroom = configured capacity − observed throughput**, computed **deterministically**
  and **null** when either capacity or throughput is unavailable (never invented).
- **Cache hit ratio** is only accepted in `[0, 1]`; anything else is dropped with a warning.
- Health = **worst of** the throughput-utilisation and CPU-utilisation classifications
  (target 70%, warning 80%, critical 90%; warning/critical overridable). Origin health is
  classified from CPU utilisation.

## Statuses
`healthy` / `above_target` / `warning` / `critical` / `stale` (value older than
`CACHE_TELEMETRY_STALE_AFTER_SECONDS`, last value shown, flagged) / `unavailable` (enabled
but no fresh value) / `telemetry_not_connected` (disabled).

## Persistence & security
- No persistence: only the latest value is cached in memory for
  `CACHE_TELEMETRY_CACHE_TTL_SECONDS`. Historical telemetry stays with the source platform.
- Read-only GET only; HTTPS required outside development; credentials only from a mounted
  secret, never logged or returned. The API never returns source URLs, queries or auth
  headers. No cloud-specific SDK. No write path exists.

See [../api/cache-telemetry.md](../api/cache-telemetry.md) and
[../frontend/live-steering.md](../frontend/live-steering.md).

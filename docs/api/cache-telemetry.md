# RADAR API — cache-pool / cache-node / origin telemetry

Read-only, **informational** telemetry for the Réalta cache pools, cache nodes and origin.
RADAR never modifies NS1 or Cloudflare from telemetry. Configured capacity/node-count are
returned **separately** from observed throughput/CPU/hit-ratio.

All routes require **`topology.summary.read`** (NOC Viewer and above; unauthenticated → 401).
Engineering detail (thresholds, warnings) is revealed only with **`ns1.detail.read`**. Invalid
query → **`400`**; unknown pool/node → **`404`**. OpenAPI at `/api/v1/openapi.json`.

## Endpoints
| Route | Notes |
|---|---|
| `GET /api/v1/telemetry/cache-pools` | Filters: `site`, `status`, `stale`. |
| `GET /api/v1/telemetry/cache-pools/:poolId` | 404 if unknown. |
| `GET /api/v1/telemetry/cache-nodes` | Filters: `site`, `poolId`, `status`, `stale`. |
| `GET /api/v1/telemetry/cache-nodes/:nodeId` | 404 if unknown. |
| `GET /api/v1/telemetry/origin` | Single origin sample. |

## Cache-pool sample
```jsonc
{
  "provenance": { "source": "radar", "telemetryMode": "mock", "readOnly": true, "informationalOnly": true,
    "notice": "Cache and origin telemetry are informational. RADAR is not automatically modifying NS1 or Cloudflare.", "retrievedAt": "…" },
  "count": 4,
  "items": [{
    "poolId": "donnybrook-1", "poolName": "Donnybrook Pool 1", "site": "Donnybrook",
    "cacheNodeCount": 2, "configuredCapacityBps": 160000000000,
    "observedOutboundBps": 80000000000, "observedUtilisationPercent": 50,
    "headroomBps": 80000000000, "cpuUtilisationPercent": 55, "memoryUtilisationPercent": 60,
    "cacheHitRatio": 0.96, "requestRate": 42000,
    "status": "healthy", "stale": false,
    "freshness": { "ageSeconds": 3, "staleAfterSeconds": 120, "fresh": true },
    "observedAt": "…", "source": "mock", "provenance": { … }
    // with ns1.detail.read: "targetPercent", "warningPercent", "criticalPercent", "warnings"
  }]
}
```

## Origin sample
`{ provenance, item: { originId, originName, requestRate, outboundBandwidthBps,
cpuUtilisationPercent, status, stale, freshness, observedAt, source, provenance } }`.

## Honesty & safety
- **Configured ≠ observed**: `configuredCapacityBps` / `cacheNodeCount` are manually
  maintained; `observed*` are from the source.
- **Headroom** = `configuredCapacityBps − observedOutboundBps`, `null` when either is
  unavailable (never invented). **Cache hit ratio** outside `[0,1]` is dropped with a warning.
- **Never invents a value**: disabled → `telemetry_not_connected`; enabled-but-no-value →
  `unavailable`; old value → `stale` (last value shown, flagged).
- **No secrets**: never returns source URLs, queries, credentials or auth headers.
- **No write path**: only GET; telemetry can never write NS1/Cloudflare or change steering
  state. Health is worst-of throughput/CPU; the **responsibility boundary** (NS1 selects
  Réalta, Cloudflare selects the pool, RADAR only observes) is surfaced in the UI.

Adapter, configured context, Prometheus model and thresholds:
[../architecture/cache-telemetry.md](../architecture/cache-telemetry.md).

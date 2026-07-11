# RADAR API — network-path telemetry

Read-only, **informational** utilisation for the configured PNI / INEX / transit paths. RADAR
never modifies NS1 steering from telemetry. Configured capacity/target are returned
**separately** from observed utilisation.

Both endpoints require **`topology.summary.read`** (NOC Viewer and above; unauthenticated →
401). Engineering detail (interface mapping, thresholds, warnings) is revealed only to callers
with **`ns1.detail.read`** (Viewing Engineer and above). Invalid query → **`400`**. OpenAPI at
`/api/v1/openapi.json`.

## `GET /api/v1/telemetry/network-paths`
Latest sample for every configured path. Bounded filters: `pathType` (`PNI|INEX|transit`),
`status`, `stale` (`true|false`).

```jsonc
{
  "provenance": { "source": "radar", "telemetryMode": "mock", "readOnly": true, "informationalOnly": true,
    "notice": "Network telemetry is currently informational. RADAR is not automatically modifying NS1 steering.", "retrievedAt": "…" },
  "count": 4,
  "items": [{
    "pathId": "eir-pni", "pathName": "Eir PNI", "pathType": "PNI",
    "status": "healthy", "stale": false,
    "freshness": { "ageSeconds": 3, "staleAfterSeconds": 120, "fresh": true },
    "configuredCapacityBps": 100000000000, "configuredTargetPercent": 70,
    "observedInboundBps": 18000000000, "observedOutboundBps": 52000000000,
    "observedUtilisationPercent": 52, "observedAt": "…", "source": "mock",
    "provenance": { "source": "mock", "synthetic": true, "readOnly": true, "informationalOnly": true, "note": "MOCK / SYNTHETIC — not production telemetry." }
    // with ns1.detail.read, additionally:
    // "interfaceIdentity": "pni-eir", "direction": "outbound",
    // "warningThresholdPercent": 80, "criticalThresholdPercent": 90, "warnings": []
  }]
}
```

## `GET /api/v1/telemetry/network-paths/:pathId`
One path (`{ provenance, item }`). **`404`** for an unknown path id.

## Roles
- **NOC Viewer** (`topology.summary.read`): path status, observed utilisation, configured
  capacity/target, freshness, source, provenance.
- **Viewing Engineer** (`ns1.detail.read`): additionally the interface identity, thresholds,
  direction and warnings.

## Honesty & safety
- **Configured ≠ observed**: `configuredCapacityBps`/`configuredTargetPercent` are RADAR
  config; `observed*` are from the source.
- **Never invents a value**: disabled → `telemetry_not_connected`; enabled-but-no-value →
  `unavailable`; old value → `stale` (last value shown, flagged). Utilisation is `null` for a
  missing rate or non-positive capacity.
- **No secrets**: never returns the source URL, the query, credentials or auth headers.
- **No write path**: only GET is exposed; telemetry can never trigger an NS1 write or change
  persisted steering state.

Adapter, mappings, Prometheus query model and thresholds:
[../architecture/network-telemetry.md](../architecture/network-telemetry.md).

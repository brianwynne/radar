# API — CloudVision network telemetry (read-only)

Read-only, informational routes under `/api/v1/network`. All require authentication and the
`topology.summary.read` permission (NOC Viewer and above). Engineering detail (classification
source, per-object warnings) is gated on `ns1.detail.read` (Viewing Engineer and above). No
route mutates anything; responses never contain the CloudVision endpoint URL, token or raw wire
bodies. Architecture: [docs/architecture/cloudvision-telemetry.md](../architecture/cloudvision-telemetry.md).

Every response carries a provenance envelope:

```json
{ "source": "radar", "telemetryMode": "mock|cloudvision|disabled",
  "readOnly": true, "informationalOnly": true, "notice": "…", "retrievedAt": "ISO" }
```

## GET /api/v1/network/status
Connector status + latest snapshot summary/freshness/completeness.
```json
{ "provenance": {…},
  "status": { "enabled": true, "running": true, "source": "mock", "intervalMs": 10000,
              "lastPollAt": "ISO", "lastSuccessAt": "ISO", "lastDurationMs": 12,
              "consecutiveFailures": 0, "lastError": null, "snapshotAgeSeconds": 4,
              "historyLength": 42, "deviceCount": 2, "interfaceCount": 8, "unknownInterfaceCount": 0 },
  "summary": { "totalEdgeThroughputBps": …, "totalPeeringThroughputBps": …, "totalTransitThroughputBps": …,
               "operationalCapacityBps": …, "operationalHeadroomBps": …, "unhealthyLinks": 0,
               "unhealthyBgpPeers": 0, "deviceCount": 2, "interfaceCount": 8, "unknownInterfaceCount": 0,
               "telemetryAgeSeconds": 4 },
  "freshness": { "level": "FRESH", "ageSeconds": 4, "staleAfterSeconds": 30 },
  "completeness": { "level": "complete", … }, "warnings": [], "capturedAt": "ISO" }
```

## GET /api/v1/network/devices
`{ provenance, count, items: NetworkDevice[] }` — id, hostname, modelName, softwareVersion,
streaming, reachable, freshness, observedAt. (detail adds `warnings`, `provenance`.)

## GET /api/v1/network/interfaces
`{ provenance, count, items: NetworkInterface[] }`. Core fields: deviceId, deviceHostname, name,
description, provider, location, linkType, adminState, operState, speedBps (configured),
inBps/outBps/primaryBps (observed), bandwidthSource (`REPORTED|DERIVED|UNAVAILABLE`),
utilisationPercent, headroomBps, inErrors/outErrors/inDiscards/outDiscards, status, freshness,
observedAt. Detail adds `classificationSource`, `warnings`.
Filters: `deviceId`, `provider`, `linkType`, `status`, `unknownOnly=true`.

## GET /api/v1/network/link-groups
`{ provenance, count, items: LinkGroupState[] }` — provider/link-type aggregates: key, label,
linkType, capacityBps, currentBps, utilisationPercent (**total/total, never averaged**),
headroomBps, healthyLinks/totalLinks, status, freshness, interfaceIds.

## GET /api/v1/network/bgp-peers
`{ provenance, count, items: BgpPeer[] }` — deviceId, deviceHostname, peerAddress, peerAsn,
provider, state (`ESTABLISHED|IDLE|CONNECT|ACTIVE|OPENSENT|OPENCONFIRM|UNKNOWN`), established,
uptimeSeconds, prefixesReceived, prefixesAdvertised, status, freshness. (detail adds `warnings`.)
Filters: `deviceId`, `provider`, `state`, `established`.

## GET /api/v1/network/history
`{ provenance, count, items: HistoryPoint[] }` — bounded in-memory time series for the charts:
at, totalEdge/Peering/TransitThroughputBps, operationalCapacityBps, operationalHeadroomBps,
unhealthyLinks, unhealthyBgpPeers, freshness. Filter: `limit` (1–1000).

## Status semantics
- Health (`status`): `healthy | warning | critical | down | unavailable | unknown`.
- Freshness (`freshness.level`): `FRESH | DEGRADED | STALE | UNAVAILABLE` (time-based, separate
  from health).
- A disabled connector returns `status.enabled=false` and empty collections (honest
  "not connected", never invented data).

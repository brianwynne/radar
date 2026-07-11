# RADAR API — Live Steering

Read-only endpoints that surface the **Current Expected DNS Steering** RADAR has persisted:
the deterministic result of evaluating NS1's Filter Chain per configured ISP scenario. This
is **expected steering derived from configuration — never measured traffic.** No NS1 writes,
no sockets: the frontend polls `/events` and reads `/state` on demand.

All three require **`steering.summary.read`** (NOC Viewer and above; unauthenticated → 401).
State and events return **`503`** when persistence is unconfigured. Filtering is bounded and
**parameterised** (no string-built SQL); invalid query → **`400 INVALID_REQUEST`**. OpenAPI
at `/api/v1/openapi.json`.

## `GET /api/v1/live-steering/config`
Static configuration for the view: selectable ISP scenarios (id, name, ASN, ECS prefix,
configured preferred network path), watched records, the steering-change **reason
vocabulary** (id → label), `maxSelectableIsps` (6), `pollIntervalsSeconds` (`[15,30,60]`,
default 30) and `highlightSeconds` (10).

## `GET /api/v1/live-steering/state`
Latest persisted state per ISP scenario. Bounded filters: `isp`, `asn`, `record`.

```jsonc
{
  "provenance": { "source": "radar", "readOnly": true, "label": "Current Expected DNS Steering", "retrievedAt": "…" },
  "count": 1,
  "items": [{
    "ispId": "eir", "ispName": "Eir", "asn": 5466, "resourceKey": "rte.ie/live.rte.ie/A",
    "identitySource": "ecs", "country": "IE", "matchedPrefix": "185.2.100.0/24",
    "preferredPath": "Eir PNI", "eligibleAnswerIds": ["ans-realta","ans-fastly"],
    "distribution": [{ "answerId": "ans-realta", "label": "Réalta", "deliveryPlatform": "Réalta", "share": 0.7 }],
    "filterChain": ["up","weighted_shuffle"], "complete": true,
    "fingerprint": "sha256:…", "structuralChecksum": "sha256:…",
    "evaluatedAt": "…", "updatedAt": "…"
  }]
}
```

## `GET /api/v1/live-steering/events`
Meaningful steering-change events, **newest first**. Bounded filters: `isp`, `asn`,
`record`, `since` (strictly after), `before` (at or before), `limit` (1..500, default 100).

```jsonc
{
  "provenance": { "source": "radar", "readOnly": true, "label": "Current Expected DNS Steering", "retrievedAt": "…" },
  "count": 1,
  "items": [{
    "id": "…", "occurredAt": "…", "ispId": "eir", "ispName": "Eir", "asn": 5466,
    "resourceKey": "rte.ie/live.rte.ie/A",
    "reason": "answer_became_unavailable", "reasonLabel": "A delivery platform became unavailable",
    "previousFingerprint": "sha256:…", "currentFingerprint": "sha256:…",
    "previousChecksum": "sha256:…", "currentChecksum": "sha256:…",
    "previousState": { /* full prior state */ }, "currentState": { /* full new state */ },
    "activity": { "action": "update" }
  }]
}
```

An event exists **only** when the stable steering fingerprint changed (eligibility,
distribution, completeness, identity, path or record structure) — never for a
timestamp-only change or a Weighted-Shuffle re-order. Unexplainable structural changes carry
`reason: "unknown_structural_change"` / *"Reason not yet attributable"*; RADAR does not
invent causality. Fingerprinting and attribution are documented in
[../architecture/change-detection.md](../architecture/change-detection.md).

## Safety
Read-only; never returns NS1 keys, tokens, headers, cookies, SQL or stack traces. The
`activity` object carries only safe, non-sensitive change metadata (actor identity, action).

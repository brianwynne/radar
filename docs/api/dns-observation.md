# RADAR API — Tier-2 DNS observation

Read-only APIs that verify what resolvers actually return for the configured ISP scenarios and
compare against RADAR's predicted NS1 evaluation. RADAR never writes to NS1 or Cloudflare and
never claims anything about actual delivered traffic. Three tiers are surfaced and never
merged: **Predicted DNS steering**, **Observed DNS answer**, **Actual traffic** (not connected).

Permissions: `state`, `history`, `config` require **`dns.explain.read`** (Viewing Engineer and
above); the manual **`run`** requires **`dns.observed.run`**. Unauthenticated → 401; NOC → 403.
Invalid query/body → 400; unknown ISP → 404; missing persistence → 503. OpenAPI at
`/api/v1/openapi.json`.

## Endpoints
| Route | Perm | Notes |
|---|---|---|
| `GET /api/v1/dns-observation/config` | `dns.explain.read` | Scenarios (resolver addresses are RADAR-owned placeholders), tier labels, comparison/confidence vocabularies, mode. |
| `GET /api/v1/dns-observation/state` | `dns.explain.read` | Latest observation per ISP (the OBSERVED DNS answer tier). |
| `POST /api/v1/dns-observation/run` | `dns.observed.run` | Manually observe one ISP (`{ "ispId": "eir" }`) or all (`{}`). One DNS query per ISP. |
| `GET /api/v1/dns-observation/history` | `dns.explain.read` | Bounded history; filters: isp, resolver, domain, type, status, checksum, since, before, limit (≤500). |

## Observation item
```jsonc
{
  "id": "…", "observedAt": "…", "freshness": { "ageSeconds": 5, "staleAfterSeconds": 900, "fresh": true },
  "ispId": "eir", "ispName": "Eir", "asn": 5466, "resolverIp": "192.0.2.11",
  "zone": "rte.ie", "domain": "live.rte.ie", "recordType": "A",
  "responseCode": "NOERROR", "ecsRequested": true, "ecsPrefix": "203.0.113.0/24", "ecsHonoured": true,
  "ttl": 30, "latencyMs": 12, "confidence": "medium",
  "comparisonStatus": "match", "matchStatus": "match",
  "differences": [{ "kind": "resolver_only_observation", "detail": "…" }],
  "observedAnswers": [{ "type": "A", "address": "192.0.2.10" }],
  "predictedAnswers": [{ "answerId": "ans-realta", "addresses": ["192.0.2.10"] }],
  "predictedDistribution": [{ "answerId": "ans-realta", "label": "Réalta", "share": 0.7 }],
  "observedOrder": ["192.0.2.10", "192.0.2.20"],
  "recordChecksum": "sha256:…", "explanation": "…", "warnings": [],
  "provenance": { "source": "radar", "label": "Observed DNS answer", "readOnly": true }
}
```

## Comparison & confidence
- **comparisonStatus**: `match` / `partial_match` / `mismatch` / `observation_unavailable` /
  `confidence_low` / `unknown`. At low/unknown confidence RADAR does not assert a match/mismatch
  (→ `confidence_low`).
- **differences** (typed): `same_set_different_order`, `missing_predicted_answer`,
  `unexpected_observed_answer`, `ttl_difference`, `ecs_discrepancy`, `resolver_only_observation`,
  `partial_radar_evaluation`, `unsupported_record_filter`, `no_response`, `dns_error_response`.
- A single observation is one **sample**: answer-order differences are not a mismatch for
  probabilistic records, and a `select_first_n` sample within the eligible pool is a match.

## Safety
- **No secrets**: never returns tokens, credentials, NS1 keys, packet captures or raw resolver
  logs. Resolver addresses shown are RADAR-owned placeholders until RTÉ confirms real endpoints.
- **No write path**: only GET + the read-only observation `run`; RADAR never writes NS1 or
  Cloudflare and never mutates steering state. **Actual traffic remains "telemetry not
  connected"**.

Adapter, scenarios, scheduling and the three-tier model:
[../architecture/dns-observation.md](../architecture/dns-observation.md).

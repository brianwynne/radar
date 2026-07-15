# Operating the CloudVision connector

Read-only network telemetry from Arista CloudVision. Architecture:
[docs/architecture/cloudvision-telemetry.md](../architecture/cloudvision-telemetry.md). API:
[docs/api/cloudvision-network.md](../api/cloudvision-network.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDVISION_ENABLED` | `false` | Master switch. When false the connector is `disabled` (dashboard shows "not connected"). |
| `CLOUDVISION_MODE` | `mock` | `mock` (synthetic, no credentials) or `live`. |
| `CLOUDVISION_ENDPOINT` | — | CloudVision base URL (live only; HTTPS required outside development). |
| `CLOUDVISION_TOKEN` | — | Service-account token (live only). Prefer the mounted secret below. |
| `CLOUDVISION_EDGE_DEVICE_IDS` | — | Comma-separated device ids (serials) to expect/restrict. Empty = all discovered. |
| `CLOUDVISION_TIMEOUT_SECONDS` | `10` | Per-request timeout. |
| `CLOUDVISION_POLL_INTERVAL_SECONDS` | `10` | Poll interval. |
| `CLOUDVISION_VERIFY_TLS` | `true` | TLS certificate verification (keep true in production). |
| `CLOUDVISION_MAX_SAMPLE_AGE_SECONDS` | `30` | Freshness window (FRESH ≤ this). |
| `CLOUDVISION_RETRY_ATTEMPTS` | `3` | Transient-failure retries (bounded backoff + jitter). |
| `CLOUDVISION_WARNING_PERCENT` | `80` | Interface utilisation warning threshold. |
| `CLOUDVISION_CRITICAL_PERCENT` | `90` | Interface utilisation critical threshold (must be ≥ warning). |
| `CLOUDVISION_PRIMARY_DIRECTION` | `outbound` | Direction that drives utilisation. |
| `CLOUDVISION_CLASSIFICATION_FILE` | — | Path to a JSON classification override (see below). |
| `CLOUDVISION_MOCK_SCENARIO` | `normal` | Mock scenario (mock mode only). |

The **token is read from `/run/secrets/cloudvision_token` first**, then `CLOUDVISION_TOKEN`;
it is held in memory only and is never logged. Mock mode requires **no credentials**. Live mode
fails fast and clearly if the endpoint or token is missing.

### Example — mock (no secrets)

```env
CLOUDVISION_ENABLED=true
CLOUDVISION_MODE=mock
CLOUDVISION_EDGE_DEVICE_IDS=JPE00000001,JPE00000002
```

### Example — live (secret mounted, not in env)

```env
CLOUDVISION_ENABLED=true
CLOUDVISION_MODE=live
CLOUDVISION_ENDPOINT=https://www.arista.io
CLOUDVISION_EDGE_DEVICE_IDS=JPExxxxxxx1,JPExxxxxxx2
CLOUDVISION_VERIFY_TLS=true
# token provided via /run/secrets/cloudvision_token (Docker/K8s secret) — NOT in env
```

### Classification override (`CLOUDVISION_CLASSIFICATION_FILE`)

```json
{
  "rules": [
    { "match": { "kind": "description_regex", "pattern": "\\beir\\b", "flags": "i" },
      "linkType": "PRIVATE_PEERING", "provider": "Eir", "location": "Dublin" },
    { "match": { "kind": "device_interface", "deviceId": "JPExxxxxxx1", "interface": "Ethernet9" },
      "linkType": "TRANSIT", "provider": "Cogent" }
  ],
  "providerForAsn": { "5466": "Eir" }
}
```

Invalid regex or JSON fails startup (fail fast, never silently non-matching).

## Validation

Run the read-only validation command before trusting a live connection:

```bash
npm run -w @radar/api cloudvision:validate
```

It validates configuration, authenticates, discovers routers, retrieves interfaces + BGP,
computes throughput/capacity/headroom, and reports freshness/completeness — performing **zero
write operations**. Exit codes: `0` pass; `1` a check failed (missing routers, no
peering/transit interfaces, no devices, or critically stale telemetry); `2` authentication or
transport failure. The token and endpoint URL are never printed (only the endpoint host).

## Token rotation

1. Issue a new read-only service-account token in CloudVision (Settings → Access Management →
   Service Accounts). Keep the old one valid until step 4.
2. Update the mounted secret (`/run/secrets/cloudvision_token`) — e.g. `docker secret` /
   Kubernetes `Secret` — with the new value.
3. Restart / roll the `radar-api` replicas so they read the new secret. (No code change.)
4. Confirm with `cloudvision:validate` (or the dashboard's connector status), then revoke the
   old token in CloudVision.

An expired/invalid token surfaces as `CLOUDVISION_AUTH` / `CLOUDVISION_TOKEN_EXPIRED` in the
connector status (`lastError`) and dashboard — polling backs off and the last good snapshot is
retained until a valid token is restored.

## Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| Dashboard shows "not connected" | `CLOUDVISION_ENABLED=false`, or `CLOUDVISION_MODE=disabled`. Enable it. |
| `status.lastError = CLOUDVISION_AUTH` | Token invalid/expired or lacks read scope — rotate (above). |
| `status.lastError = CLOUDVISION_UPSTREAM_TIMEOUT` | Endpoint unreachable or slow; check network path / raise `CLOUDVISION_TIMEOUT_SECONDS`. |
| Interfaces present but bandwidth `UNAVAILABLE` | Live NetDB path/shape differs from the grounded default (interface/BGP paths are pending live confirmation) — capture the real payload and adjust the mapping. |
| Many `UNKNOWN` interfaces | Classification rules don't match your descriptions — add rules via `CLOUDVISION_CLASSIFICATION_FILE`. |
| Freshness `STALE` | Devices not streaming, or the poll is failing — check device streaming status and `lastError`. |
| Missing routers in validation | `CLOUDVISION_EDGE_DEVICE_IDS` lists a serial not in inventory (or not onboarded). |

## Security summary

Read-only (no write path, GET-only client); token from a mounted secret, memory-only, never
logged or returned; endpoint URL and wire bodies never in API responses; HTTPS enforced for the
live endpoint outside development; RBAC-gated (`topology.summary.read`, detail on
`ns1.detail.read`). See [docs/threat-model.md](../threat-model.md) and
[docs/security/README.md](../security/README.md).

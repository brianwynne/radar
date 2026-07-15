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

## Engineer-managed connection (UI)

Engineers (permission `connector.manage`) can manage the endpoint and token from the
**CloudVision Setup** screen (`/network/connection`) — no restart or redeploy needed. When
settings are managed here they are persisted in Postgres and **override the environment base
config**; the running poller is reconfigured in place.

- The **token is write-only**: it is never fetched, displayed, logged or returned. The field
  starts blank — *leave it blank to keep the stored token*, type a value to replace it, or
  tick **Clear the stored token** to remove it. The masked placeholder is never sent as a value.
- **Storing a token requires the master key** (below). Without it, non-secret settings are
  editable but a token cannot be saved (the API returns `409 MASTER_KEY_UNAVAILABLE`).
- **Test connection** runs one read-only snapshot against the saved connection and reports
  pass/fail — it never persists or returns the token.
- Every change is audited (`connector.settings.updated`) recording the action taken
  (`tokenAction: replace|clear|retain`) but **never the secret**.
- Non-secret settings can also still be provided by env (they are the base/default); the
  encrypted token can additionally be supplied out-of-band via `/run/secrets/cloudvision_token`
  for a first live connection before anything is saved in the UI.

## Master key (`/run/secrets/radar_master_key`)

The token is stored in Postgres **only as AES-256-GCM ciphertext**. The encryption master key
is supplied solely at runtime via the mounted secret `/run/secrets/radar_master_key` and is
**never stored in the database** — a database backup therefore contains ciphertext alone.

Provision a 32-byte key (recommended: base64 or hex; a long passphrase is also accepted and
hashed to 32 bytes):

```bash
openssl rand -base64 32    # → put the output in the secret
```

Mount it as `radar_master_key` (Docker/K8s secret) on `radar-api`. If it is absent or invalid,
the connector **fails closed**: no token can be stored or decrypted, and a live connection
degrades to "not connected" (the UI shows a master-key warning) — it never falls back to
plaintext or a guess.

### Master-key rotation

Rotating the master key means re-wrapping the stored token under a new key. Because the API
decrypts with the mounted key and re-encrypts on the next token write, the safe procedure is:

1. **Before rotating**, in the CloudVision Setup screen, confirm the current token works
   (**Test connection**) and have the plaintext token to hand (you will re-enter it once).
2. Generate the new key (`openssl rand -base64 32`).
3. Update the `radar_master_key` secret with the new value and roll the `radar-api` replicas.
   (The old ciphertext can no longer be decrypted with the new key — expected; the connector
   will report degraded until step 4.)
4. In the UI, **re-enter the token and Save**. This encrypts it under the new key (unique
   nonce) and reconfigures the connector. Confirm with **Test connection**.
5. Destroy the old key material.

If you cannot re-enter the token, instead: set the connector to mock (or clear the token)
before rotating, rotate the key, then re-add the token afterwards. There is deliberately no
way to export the stored token to re-wrap it automatically — the plaintext never leaves the
connector boundary.

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

# RADAR API — read-only NS1 & DNS routes

All routes are **read-only** and served under `/api/v1`. RBAC is enforced server-side
(permissions from the authenticated principal). Every NS1-derived response carries a
`provenance` object; in mock mode `synthetic: true` with a disclaimer. Errors are safe:
the NS1 key, tokens, headers, raw upstream bodies and stack traces are never returned.

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /api/v1/ns1/config` | `dashboard.read` | Mode (mock/live) + synthetic flag. |
| `GET /api/v1/ns1/zones` | `ns1.detail.read` | List zones. |
| `GET /api/v1/ns1/zones/:zone` | `ns1.detail.read` | Complete zone JSON. |
| `GET /api/v1/ns1/zones/:zone/:domain/:type` | `ns1.detail.read` | Normalised record. |
| `GET /api/v1/ns1/zones/:zone/:domain/:type/raw` | `ns1.raw.read` | Raw record (verbatim). |
| `GET /api/v1/ns1/activity` | `audit.read` | Normalised NS1 activity log. |
| `POST /api/v1/dns/explain` | `dns.explain.read` | Filter-by-filter evaluation. |

There is **no write route** and **no generic NS1 proxy**. OpenAPI for all of these is at
`GET /api/v1/openapi.json` (and Swagger UI at `/api/v1/docs` in development).

## GET /api/v1/ns1/activity

`GET /v1/account/activity` upstream, **normalised**. Requires `audit.read` (Viewing
Engineer and above; a NOC viewer receives 403).

### Query (all optional, validated; invalid → 400 `INVALID_REQUEST`)
- `limit` — integer 1..500. Passed upstream (the only NS1-side parameter used).
- `actor`, `action`, `resource` — RADAR-side, case-insensitive contains filters applied
  to the normalised list. NS1's own filter parameters for this endpoint are
  FIXTURE-PENDING, so unverified params are not forwarded upstream.

### Response
```jsonc
{
  "provenance": { "source": "ns1", "mode": "mock", "synthetic": true, "readOnly": true,
                  "endpoint": "/v1/account/activity", "retrievedAt": "…", "disclaimer": "…" },
  "mappingNote": "Field mapping is fixture-derived; unconfirmed NS1 fields appear only under each item's raw object.",
  "count": 3,
  "items": [
    { "id": "…", "occurredAt": "…", "actor": "…", "action": "update",
      "resourceType": "record", "resourceKey": "live.rte.ie/A", "outcome": "success",
      "detail": "…", "raw": { /* original entry, credential-like keys stripped */ } }
  ]
}
```

### Normalisation & safety
- Only plausible, confirmed-shaped fields are mapped (timestamp, actor/API-key **identity**,
  action, resource type/key, outcome, safe detail). **No semantics are invented.**
- The original entry is preserved under `raw` for an engineering detail panel, with any
  credential-like key (`*key*`, `*token*`, `*secret*`, `authorization`, `cookie`, …)
  **stripped** — a secret can never leak even if NS1 ever included one. `api_key` is never
  used as the actor value.
- Upstream failures map to safe statuses (auth→502, not-found→404, rate-limit→503,
  timeout→504, other→502) with a generic code/message and the correlation id.

### Modes
- **mock** — fixture-backed, no credential; `synthetic: true`.
- **live** — real `GET /v1/account/activity` via the read-only client (HTTPS, `X-NSONE-Key`,
  never logged).

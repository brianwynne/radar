# RADAR API — audit history

`GET /api/v1/audit` exposes **RADAR's own audit trail** (`audit_events`) — the actions
RADAR itself records, such as snapshot captures. It is **distinct** from the NS1 account
activity log (`/api/v1/ns1/activity`): this is RADAR's history, that is NS1's.

Read-only. Requires `audit.read` (Viewing Engineer and above; NOC → 403;
unauthenticated → 401). `503` when persistence is unconfigured. OpenAPI at
`/api/v1/openapi.json`.

## Query (all optional, validated; invalid → 400 `INVALID_REQUEST`)
Bounded and **parameterised** (no string-built SQL); newest-first ordering.

| Param | Meaning |
|---|---|
| `limit` | 1..500 page size |
| `after`, `before` | ISO timestamps — occurrence range |
| `actor` | actor subject |
| `action` | e.g. `snapshot.create` |
| `resourceType`, `resourceKey` | resource identity |
| `outcome` | e.g. `success` / `failure` |
| `correlationId` | request correlation id |

## Response
```jsonc
{
  "provenance": { "source": "radar", "readOnly": true, "retrievedAt": "…" },
  "count": 2,
  "items": [
    { "id": "…", "occurredAt": "…", "actorSubject": "…", "actorRoles": ["ENGINEER"],
      "authenticationMethod": "dev", "action": "snapshot.create", "resourceType": "record",
      "resourceKey": "rte.ie/live.rte.ie/A", "outcome": "success", "correlationId": "…",
      "details": { "snapshotId": "…", "rawChecksum": "…" } }
  ]
}
```

## Safety
Never returns secrets, tokens, request headers, cookies, raw NS1 payloads, SQL or stack
traces. Audit `details` are additionally **redacted** of any credential-like key
(`*key*`, `*token*`, `*secret*`, `authorization`, `cookie`, …) as defence in depth, even
though RADAR only ever writes safe details.

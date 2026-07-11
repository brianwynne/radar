# RADAR Frontend — API client

`src/api/client.ts` is a thin typed wrapper over the radar-api REST routes. It is the
**only** place the frontend talks to the backend; components never call `fetch` directly.
Requests are same-origin (`/api/...`), proxied to radar-api by Vite (dev) or nginx (prod)
— the NS1 key never reaches the browser.

## Methods
| Method | Route | Returns |
|---|---|---|
| `api.me()` | `GET /api/v1/me` | `Principal` |
| `api.ns1Config()` | `GET /api/v1/ns1/config` | `Ns1Status` |
| `api.zones()` | `GET /api/v1/ns1/zones` | `ZonesResponse` |
| `api.zone(zone)` | `GET /api/v1/ns1/zones/:zone` | `ZoneResponse` |
| `api.record(zone, domain, type)` | `GET …/:zone/:domain/:type` | `RecordResponse` |
| `api.rawRecord(zone, domain, type)` | `GET …/:type/raw` | `RawRecordResponse` |
| `api.activity(limit?)` | `GET /api/v1/ns1/activity` | `ActivityResponse` |
| `api.audit(limit?)` | `GET /api/v1/audit` | `AuditListResponse` |
| `api.explain(body)` | `POST /api/v1/dns/explain` | `ExplainResponse` |
| `api.snapshots(zone, domain, type)` | `GET …/:type/snapshots` | `SnapshotHistory` |
| `api.captureSnapshot(zone, domain, type, label?)` | `POST …/:type/snapshots` | `SnapshotCaptureResponse` |
| `api.snapshot(id)` | `GET /api/v1/snapshots/:id` | `{ snapshot }` |
| `api.compareSnapshots(a, b)` | `POST /api/v1/snapshots/compare` | `CompareResponse` |
| `api.compareCurrent(id)` | `POST /api/v1/snapshots/:id/compare-current` | `CompareCurrentResponse` |

## Errors
Non-2xx responses throw `ApiError { status, code, message }`. Callers map:
- `401` → the app shows "Authentication required" (`AuthContext.unauthenticated`).
- `403` → the UI shows a permission notice (RBAC is cosmetic in the UI; the API enforces).
- NS1 upstream errors (`NS1_*`) → surfaced as safe error notices; no upstream detail.

Path components are `encodeURIComponent`-encoded. All types mirror the API contract in
`src/api/types.ts`. Activity `actor`/`action`/`resource` filtering is applied client-side
over the already-fetched, safe payload (the API also supports server-side filtering).

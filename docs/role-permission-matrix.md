# RADAR Role / Permission Matrix

RBAC is **permission-based**, enforced independently by the API (brief §6.2). Roles are
bundles of permissions; handlers check **permissions**, never role names. The frontend
may hide unavailable controls but never enforces.

## Roles (inheriting)

- **NOC Viewer** — "Is the delivery platform healthy?" High-level operational monitoring.
- **Viewing Engineer** — inherits NOC Viewer — "Why is traffic being steered this way?"
  Detailed read-only engineering visibility.
- **Engineer** — inherits Viewing Engineer — "How should the delivery model be maintained
  safely?" Maintains RADAR-owned metadata only. **Still cannot write to NS1.**

## Permissions

| Permission | NOC Viewer | Viewing Engineer | Engineer |
|---|:--:|:--:|:--:|
| `dashboard.read` | ✅ | ✅ | ✅ |
| `steering.summary.read` | ✅ | ✅ | ✅ |
| `topology.summary.read` | ✅ | ✅ | ✅ |
| `dns.explain.read` | — | ✅ | ✅ |
| `ns1.detail.read` | — | ✅ | ✅ |
| `ns1.raw.read` | — | ✅ | ✅ |
| `simulation.run` | — | ✅ | ✅ |
| `dns.observed.run` | — | ✅ | ✅ |
| `snapshot.read` | — | ✅ | ✅ |
| `snapshot.create` | — | — | ✅ |
| `topology.manage` | — | — | ✅ |
| `mapping.manage` | — | — | ✅ |
| `threshold.manage` | — | — | ✅ |
| `audit.read` | — | ✅ | ✅ |

NOC Viewer explicitly **cannot** see raw NS1 JSON, Filter Chain internals, ASN/prefix
metadata, engineering simulations, or topology administration.

## Route → permission (v1 slice + planned)

| Route | Permission |
|---|---|
| `GET /api/v1/health` | (public) |
| `GET /api/v1/me` | (authenticated) |
| `GET /api/v1/dashboard` | `dashboard.read` |
| `GET /api/v1/ns1/zones`, `/ns1/zones/:zone`, `/ns1/records/...` | `ns1.detail.read` |
| `GET /api/v1/ns1/records/.../raw` | `ns1.raw.read` |
| `POST /api/v1/evaluations`, `GET /api/v1/evaluations/:id` | `simulation.run` / `dns.explain.read` |
| `GET /api/v1/topology` | `topology.summary.read` (detail gated by `dns.explain.read`) |
| `POST /api/v1/snapshots` | `snapshot.create` |
| `GET /api/v1/snapshots`, `/:id`, `POST /snapshots/compare` | `snapshot.read` |
| `GET /api/v1/audit` | `audit.read` |
| `GET /api/v1/dns-observation/config`, `/state`, `/history` | `dns.explain.read` |
| `POST /api/v1/dns-observation/run` | `dns.observed.run` |
| `GET/PUT /api/v1/admin/mappings...` | `mapping.manage` |
| `GET/PUT /api/v1/admin/thresholds...` | `threshold.manage` |

**No NS1 write routes exist.** No generic passthrough endpoint exists.

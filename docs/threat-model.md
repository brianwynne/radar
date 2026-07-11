# RADAR Threat Model (v1)

Method: STRIDE over the locked architecture (ADR-0001). Scope: v1, read-only to NS1.

## Assets

- **NS1 view-only API key** (highest-value secret; lives only in `radar-api`).
- OIDC client secret; session cookies.
- Durable RADAR state in PostgreSQL (snapshots, topology, mappings, audit).
- Raw NS1 configuration (competitively/operationally sensitive).

## Trust boundaries

Browser ↔ `radar-web` ↔ `radar-api` ↔ {NS1 API (outbound, GET-only), PostgreSQL}.
The NS1 key never crosses the `radar-api` → browser boundary.

## STRIDE

| Threat | Vector | Mitigation (v1) |
|---|---|---|
| **Spoofing** | Forged identity / unauthenticated access | OIDC (any standard provider); JWT validated (issuer/aud/exp) via JWKS; short sessions; documented local-dev mode kept separate from prod. |
| **Tampering** | Request/param tampering; SQL injection | Strict per-route input schemas; parameter allow-lists; parameterised queries only; request size limits; no generic upstream proxy. |
| **Repudiation** | Actions not attributable | Structured audit log (user, mapped role, action, resource, outcome, correlation ID, timestamp) to Postgres; audit separate from telemetry. |
| **Information disclosure** | NS1 key or raw config leaking | Key only in `radar-api`, from `/run/secrets/ns1_api_key` or env (dev); never sent to browser, logged or imaged; secret redaction in logs; `ns1.raw.read` gated (NOC Viewer denied); safe error responses (no stack/secret leakage). |
| **Denial of service** | Upstream/DB exhaustion; unbounded evaluation | Outbound NS1 timeouts; basic rate limiting; request size limits; brief in-memory NS1 cache (never authoritative); pure, bounded evaluation engine. |
| **Elevation of privilege** | Bypassing RBAC via the UI | **API enforces every permission independently**; frontend hiding is cosmetic; deny-by-default; explicit permission checks, not role-name string matching. |

## Container security (brief §6.4)

Non-root users; multi-stage builds; runtime-only deps; health endpoints; read-only root
filesystem with an ephemeral tmp; no privileged mode; drop unnecessary Linux
capabilities; no embedded secrets; pinned dependency versions; dependency + image scanning
in CI.

## Key non-goals (v1)

No NS1 writes, no write-capable credential, no complex PKI/HSM/per-user key management.
Secret abstraction is designed so encrypted application secrets can later live in
PostgreSQL, but v1 does not implement that.

## Residual risks / follow-ups

- Geo/ASN derivation is scenario-supplied in v1 (no adapter) — no confidentiality risk,
  but correctness caveat surfaced in the UI.
- CSRF: state-changing routes (admin, snapshot create) require CSRF protection when
  cookie-based sessions are used — to implement with the API build.
- Full OIDC hardening (PKCE, step-up/assurance for privileged ops) tracked for the auth
  slice.

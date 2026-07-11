# RADAR

**Réalta Adaptive Delivery Analysis and Routing** — RTÉ's delivery traffic intelligence
and NS1 steering **explainability** platform.

RADAR reads IBM NS1 Connect configuration and explains, filter by filter, how a
hypothetical or observed DNS request is steered to a **delivery platform** (Réalta,
Fastly, Akamai, CloudFront standby), which answers remain and why, the expected
(probabilistic) distribution, and the associated RTÉ network path (PNI / INEX peering /
transit / commercial CDN). **Version 1 is read-only with respect to NS1** — there is no
NS1 write path or write-capable credential.

RADAR does not replace NS1. NS1 selects the *delivery platform*; Cloudflare selects the
*Réalta pool*; individual cache selection is downstream of both. RADAR never attributes
pool or cache selection to NS1.

## Status (increment 1)

**Built & tested now:**
- `packages/radar-engine` — the source-agnostic delivery model and the **NS1 Filter Chain
  evaluation engine** (the core). Pure, deterministic, 11 passing tests. Accounts for
  every answer at every supported stage; flags unsupported filters as partial evaluation;
  reports expected Weighted Shuffle distribution as **probabilistic**; distinguishes ECS
  vs resolver-IP identity; separates NS1 delivery-platform selection from Cloudflare pool
  selection.
- Foundation: [ADR-0001](docs/adr/0001-architecture.md), the
  [NS1 assumptions register](docs/ns1/assumptions.md) (grounded on the official NS1 Go
  SDK — the IBM developer portal blocks automated access), the
  [threat model](docs/threat-model.md), and the
  [role/permission matrix](docs/role-permission-matrix.md).

**Next increments:** `radar-api` (Fastify + OIDC + RBAC + Postgres migrations + snapshots
+ the NS1 GET-only adapter and mock adapter), then `radar-web` (React + graph UI), then
the running Docker Compose vertical slice and end-to-end test.

## Run the engine tests now

```bash
cd packages/radar-engine
npm install
npm test
```

## Architecture (locked — ADR-0001)

```
User → radar-web (React/Vite) → radar-api (Fastify/TS) → IBM NS1 Connect (GET only)
                                                        → PostgreSQL (only durable state)
```
`radar-web` and `radar-api` are stateless; a PostgreSQL backup restores all durable RADAR
state. No dependency on AWS/Azure/Kubernetes-specific services. All integrations sit
behind adapters (initial adapter: IBM NS1 Connect).

## Full stack (target)

```bash
cp .env.example .env       # RADAR_MODE=mock works with no NS1 credential
docker compose up --build  # (radar-api / radar-web land next increment)
```

## Repository layout

```
packages/radar-engine/   Source-agnostic model + NS1 evaluation engine (tested)
apps/api/          radar-api — Fastify, OIDC, RBAC, Postgres, NS1 GET-only adapter (next)
apps/web/          radar-web — React + Vite graph UI (next)
apps/mock-ns1/     Dev-only fixture-backed NS1 stand-in (next)
docs/              ADR-0001, NS1 assumptions register, threat model, role/permission matrix
docker-compose.yml Container-first stack
```

## Security posture

Read-only NS1 (GET-only client, no proxy route, no write credential). OIDC auth with a
documented local-dev mode; permission-based RBAC **enforced by the API**. The NS1 key
lives only in `radar-api` (from `/run/secrets/ns1_api_key` or a dev env var), never in the
browser, logs or images. See the [threat model](docs/threat-model.md).

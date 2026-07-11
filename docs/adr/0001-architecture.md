# ADR-0001: RADAR locked architecture

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

RADAR (*Réalta Adaptive Delivery Analysis and Routing*) makes RTÉ's current traffic
steering **understandable**: it reads NS1 Connect configuration, evaluates how a
hypothetical or observed DNS request moves through the Filter Chain, and explains which
delivery platform is selected and why. Version 1 is **read-only** with respect to NS1.

## Decision (locked)

1. **Read-only first (v1).** NS1 is accessed with a **view-only API key**; the NS1
   client implements **GET only**. There is **no generic NS1 proxy route** and **no
   POST/PUT/PATCH/DELETE** against NS1, and no write-capable credential exists.
2. **Explainability, not portal mirroring.** RADAR evaluates the Filter Chain step by
   step and accounts for **every answer** at every supported stage (retained / removed /
   reordered / standby / selected / unsupported). Unsupported filters produce an explicit
   **partial-evaluation** warning; RADAR never claims certainty past one.
3. **Preserve raw NS1 data.** Every retrieval keeps the **complete raw NS1 JSON**
   (never a discarded subset) alongside a normalised and an interpreted view. Unknown
   fields remain available.
4. **RADAR does not replace NS1.** It is not an authoritative DNS server. NS1 selects the
   **delivery platform**; Cloudflare selects the **Réalta pool**; individual cache
   selection is downstream of both. RADAR must never attribute pool/cache selection to
   NS1.
5. **Container-first, platform-independent.** Runs via `docker compose up --build`.
   Containers: `radar-web`, `radar-api`, `postgres` (+ dev-only `mock-ns1`).
   `radar-web` and `radar-api` are **stateless**; **PostgreSQL is the only durable
   state** (a Postgres backup restores all durable RADAR state). No dependency on AWS
   Lambda/DynamoDB/Cognito/S3/Secrets Manager/SQS/Step Functions/CloudFront, Azure
   services, or Kubernetes-specific APIs.
6. **Extensible adapter model.** All integrations sit behind adapters; the initial
   adapter is IBM NS1 Connect. NS1-specific logic is isolated (the domain model and
   evaluation engine are source-agnostic). Future adapters (Cloudflare, Varnish
   telemetry, PNI/INEX/transit utilisation, Prometheus, Youbora, Fastly, Akamai) attach
   without touching the domain.
7. **Security built in.** OIDC authentication (any standard provider) with a documented
   local-dev mode; **permission-based RBAC enforced by the API** (the frontend may hide
   controls but never enforces). The NS1 API key lives only in `radar-api`, never in the
   browser, logs or images. Strict input schemas, no generic upstream proxy, correlation
   IDs, structured audit logging, secure headers/cookies, rate limiting.
8. **Anticipate controlled writes without building them.** The schema reserves clean
   `ChangeProposal` / `Deployment` / `Rollback` models. A future RADAR-managed change will
   capture full pre/post snapshots, exact diff, user, approval, verification and rollback
   status; rollback restores the complete prior resource. **None of this is implemented
   in v1.**

## Stack

TypeScript throughout. Frontend: React + TypeScript + Vite + a graph library for
node-and-edge visualisation, restrained dark operational UI. Backend: Node.js +
TypeScript + Fastify, runtime schema validation, structured logging, OpenAPI. Database:
PostgreSQL with source-controlled migrations and `jsonb` for raw NS1 objects, snapshots
and evaluation traces. Testing: unit + integration + contract (captured/mocked NS1) +
component + one end-to-end for the first vertical slice.

## Consequences

- A tested, source-agnostic evaluation engine is the core asset (`packages/radar-engine`).
- NS1 remains authoritative for live config; RADAR shows data freshness everywhere and
  stores explicit snapshots in Postgres.
- The read-only, no-proxy, adapter-isolated design keeps v1 safe and the write/rollback
  future additive.

See [ns1-assumptions.md](../ns1/assumptions.md), [threat-model.md](../threat-model.md),
[role-permission-matrix.md](../role-permission-matrix.md).

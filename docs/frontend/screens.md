# RADAR Frontend — Screens

Navigation is permission-filtered (cosmetic; the API still enforces RBAC). Permissions
come from `/api/v1/me`.

| Screen | Route | Permission | Purpose |
|---|---|---|---|
| Dashboard | `/` | `dashboard.read` | NOC overview: zones count, read-only posture, telemetry-not-connected panels. |
| Explain | `/explain` | `dns.explain.read` | The core workflow — enter a DNS-request scenario, see a filter-by-filter graphical explanation. |
| Steering | `/steering` | `steering.summary.read` | Effective steering matrix; rows generated from `/api/v1/dns/explain`. |
| Topology | `/topology` | `topology.summary.read` | Configured delivery topology and the NS1/Cloudflare boundary. |
| NS1 Explorer | `/explorer[/:zone[/:domain/:type]]` | `ns1.detail.read` (raw: `ns1.raw.read`) | Zone/record discovery + inspection; URL-addressable; normalised vs raw. |
| Activity | `/activity` | `audit.read` | Read-only NS1 activity log (normalised) with a safe raw/details panel. |
| Settings | `/settings` | `mapping.manage` | Placeholder — future editable mappings/thresholds shown as disabled controls. |

## Role access (via permissions, not role-name checks)
- **NOC Viewer** — Dashboard, Steering (summary), Topology (summary).
- **Viewing Engineer** — the above plus Explain, NS1 Explorer, Activity, and the detailed
  Topology/Steering evaluation.
- **Engineer** — the above plus Settings and disabled future-edit controls.

## Explain screen
Scenario form (zone/domain/type + resolver IP, ECS, country, ASN, "Réalta down") with
presets → `POST /api/v1/dns/explain` → `EvaluationView`: derived identity (ECS vs resolver,
confidence, network path), the Filter Chain pipeline (per step: supported/unsupported,
behaviour, reorder, reason, answers flowing through with removed ones struck), eligible/
selected answers, and the expected probabilistic distribution with disclaimers. Selecting a
Steering row opens this screen pre-filled and auto-run.

## Topology screen
Two sections — **Platform steering (NS1)**: DNS Request → Resolver → NS1 → platforms; and
**Réalta origin selection (Cloudflare)**: Réalta → Cloudflare LB → pools → Origin — with an
explicit boundary note. Diagram and accessible List views, zoom/fit, configured capacity
and network-path panels (all labelled configured; utilisation *Telemetry not connected*).
Role-aware detail; Engineers additionally see disabled management controls.

## NS1 Explorer screen
Read-only discovery across every record the API exposes. Pick a zone (`GET /ns1/zones`),
see its records (`GET /ns1/zones/:zone`), and select one — the selection is
**URL-addressable** (`/explorer/:zone/:domain/:type`), so Steering ("record") and Explain
("View NS1 record") deep-link straight to it, and the Explain screen's "Explain this
record" button links back. Recently-viewed records are offered as quick chips
(localStorage, read-only client state). Normalised vs Raw views; **Raw is gated on
`ns1.raw.read`**. Loading, empty (no records) and error states throughout.

## Activity screen
Read-only NS1 account activity log via `GET /api/v1/ns1/activity` (requires `audit.read`;
a NOC viewer is denied — cosmetic notice plus API 403). A compact operational table (time,
actor, action, resource, outcome, detail) with a per-row expandable **raw** panel (safe —
credential-like fields are stripped server-side). Filter by actor/action/resource; shows
the mock/synthetic banner, provenance, data freshness, and the fixture-derived mapping
note. Loading, empty and error states. Mock events are never presented as live.

## Steering screen
Columns: Scenario, Country, ASN, Network, Prefix condition, Identity source, Eligible
platforms, Expected distribution, Preferred path, Configured target, Evaluation, Provenance,
NS1. Filters by country, ASN/network, and evaluation status. Sticky header, horizontal
scroll, loading/empty/error states. NOC sees the scenario summary; full evaluation needs
`dns.explain.read`.

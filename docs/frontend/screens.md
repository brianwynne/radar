# RADAR Frontend — Screens

Navigation is permission-filtered (cosmetic; the API still enforces RBAC). Permissions
come from `/api/v1/me`.

| Screen | Route | Permission | Purpose |
|---|---|---|---|
| Dashboard | `/` | `dashboard.read` | NOC overview: zones count, read-only posture, telemetry-not-connected panels. |
| Live Steering | `/live-steering` | `steering.summary.read` | Primary operational view — live *expected* DNS steering per ISP. |
| Explain | `/explain` | `dns.explain.read` | The core workflow — enter a DNS-request scenario, see a filter-by-filter graphical explanation. |
| Steering | `/steering` | `steering.summary.read` | Effective steering matrix; rows generated from `/api/v1/dns/explain`. |
| Topology | `/topology` | `topology.summary.read` | Configured delivery topology and the NS1/Cloudflare boundary. |
| NS1 Explorer | `/explorer[/:zone[/:domain/:type]]` | `ns1.detail.read` (raw: `ns1.raw.read`) | Zone/record discovery + inspection; URL-addressable; normalised vs raw. |
| Activity | `/activity` | `audit.read` | Two tabs: RADAR audit trail (`/api/v1/audit`) and the NS1 activity log. |
| Settings | `/settings` | `mapping.manage` | Placeholder — future editable mappings/thresholds shown as disabled controls. |

## Role access (via permissions, not role-name checks)
- **NOC Viewer** — Dashboard, Steering (summary), Topology (summary).
- **Viewing Engineer** — the above plus Explain, NS1 Explorer, Activity, and the detailed
  Topology/Steering evaluation.
- **Engineer** — the above plus Settings and disabled future-edit controls.

## Live Steering screen (`/live-steering`, `steering.summary.read`) — primary operational view
"**Current Expected DNS Steering**". Select up to six ISPs (Eir, Virgin Media, Vodafone,
Three, Sky, Digiweb); for each, RADAR repeatedly evaluates the current NS1 configuration via
`/api/v1/dns/explain` (every 15/30/60 s) and shows the expected steering path:

`ISP/ASN → Identity source → Matched policy (filter chain) → Eligible platforms → Expected
DNS distribution → Preferred Réalta network path → Cloudflare Load Balancer`.

This is **expected steering derived from configuration, not measured traffic** (measured
utilisation shows *Telemetry not connected*). **Stable fingerprinting** means only
meaningful changes (eligible answers, expected distribution, completeness, identity source,
preferred path) trigger an update — the random Weighted-Shuffle *ordering* is deliberately
ignored. On a change: the ISP path is highlighted for 10 s (respecting
`prefers-reduced-motion`), the previous→current state and a trace-derived reason are shown,
and an entry is added to **Recent Steering Changes**. Controls: pause/resume, manual
refresh, interval, last-successful-update and a stale indicator; per-ISP error handling.

RBAC: `steering.summary.read` opens the screen (NOC). The per-ISP live evaluation calls
`/api/v1/dns/explain`, which requires `dns.explain.read` — so a NOC viewer sees the summary
notice, while Viewing Engineers/Engineers get the full live paths (and the evaluation trace
with `ns1.detail.read`).

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

The selected record also shows a **Snapshots** panel (`snapshot.read`): version history
(captured time — links to detail — creator, label, checksum, synthetic tag), a **Capture
snapshot** action (`snapshot.create` — reads the record and persists it; RADAR never writes
to NS1), and a **Compare** of any two snapshots showing a field-level diff (or "identical").

## Snapshot detail (`/snapshots/:snapshotId`, `snapshot.read`)
Full metadata (resource identity, creator, capture/retrieval time, source mode, synthetic
status, raw + structural checksums, warnings) and tabs: **Summary**, **Canonical payload**,
and **Raw payload** (raw requires `ns1.raw.read`; canonical requires `snapshot.read`).
**Compare with current** fetches the live/mock record server-side and shows an
identical/changed state, per-dimension summary cards (TTL, ECS, answers, filters + reorder,
other) and a field-change table — distinguishing the **stored snapshot** from the
**current record** with mock/synthetic provenance on both. A prominent notice states
**"Comparison only — no NS1 change has been made."** There is **no Restore/Apply/Rollback**
control — RADAR is read-only to NS1.

## Activity screen
Requires `audit.read` (NOC denied — cosmetic notice plus API 403). Two clearly separated
tabs:

- **RADAR Activity** (`GET /api/v1/audit`) — RADAR's own audit trail (e.g. snapshot
  captures): time, actor, action, resource, outcome, authentication method, correlation id,
  and an expandable safe details panel. Filter by actor / action / resource / outcome /
  date range.
- **NS1 Activity** (`GET /api/v1/ns1/activity`) — the NS1 account activity log
  (normalised), with the mock/synthetic banner, provenance, and fixture-derived mapping
  note preserved; per-row expandable raw panel (credential-like fields stripped
  server-side).

RADAR audit events and NS1 account activity are kept distinct. Loading, empty and error
states on both. Mock events are never presented as live.

## Steering screen
Columns: Scenario, Country, ASN, Network, Prefix condition, Identity source, Eligible
platforms, Expected distribution, Preferred path, Configured target, Evaluation, Provenance,
NS1. Filters by country, ASN/network, and evaluation status. Sticky header, horizontal
scroll, loading/empty/error states. NOC sees the scenario summary; full evaluation needs
`dns.explain.read`.

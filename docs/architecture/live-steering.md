# Live Steering — architecture

Live Steering answers one question, continuously and explainably: **for each ISP, which
delivery platform is NS1 currently *expected* to steer to, and why did that change?** It is
**expected steering derived from configuration — never measured traffic.**

RADAR does not evaluate on every page request. The **change-detection service**
([change-detection.md](change-detection.md)) already re-evaluates the configured ISP
scenarios whenever a relevant NS1 change is detected; Live Steering **persists** that result
and serves it read-only. The browser polls, it is never pushed to (no WebSockets/SSE).

## Data model (`0002_live_steering`)
| Table | Grain | Role |
|---|---|---|
| `change_detection_checkpoints` | one row / source | durable last-processed position; restart-safe, single-poller |
| `live_steering_states` | one row / `(isp_id, resource_key)` | latest expected-steering state per ISP; always upserted |
| `steering_change_events` | one row / meaningful change | append-only history with attributed reason + before/after |

## Stable fingerprint
Each ISP state is reduced to a SHA-256 fingerprint over eligible answer ids, expected
distribution (answer → share), complete/partial, stopped-filter index, identity source,
country, ASN, matched prefix, preferred network path and the record's structural checksum.
It **excludes** timestamps, correlation ids and the random Weighted-Shuffle **ordering** —
so an event is written *only* when steering actually changed in a meaningful way. The
latest state is persisted every cycle regardless; an event is persisted only on a
fingerprint change against the previous persisted state. First observation ⇒ state only, no
event (no baseline to compare — no invented causality).

## Reason attribution
Changes are attributed by a deterministic priority to a fixed vocabulary
(`answer_became_unavailable`, `answer_became_eligible`, `asn_match_changed`,
`prefix_match_changed`, `country_match_changed`, `expected_weight_changed`,
`filter_chain_changed`, `evaluation_became_partial`, `evaluation_became_complete`,
`preferred_path_changed`, `record_checksum_changed`, `unknown_structural_change`). The last
renders as **"Reason not yet attributable"**.

## Multi-replica safety
Only the replica holding the PostgreSQL **advisory poller lock** writes state/events; others
stay passive and take over on release. The durable checkpoint plus idempotent fingerprinting
make any duplicate processing harmless (no duplicate event).

## Serving & consuming
- API: `GET /api/v1/live-steering/{config,state,events}`, `steering.summary.read`
  ([../api/live-steering.md](../api/live-steering.md)).
- Frontend: `/live-steering` polls `/events` and refreshes affected ISPs
  ([../frontend/live-steering.md](../frontend/live-steering.md)).

## Out of scope
No NS1 writes, WebSockets, SSE, Redis, queues, rollback, remediation, or invented telemetry.
PNI/INEX/transit utilisation and actual CDN traffic share stay *Telemetry not connected*.

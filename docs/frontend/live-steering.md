# Live Steering — frontend

`src/pages/LiveSteering.tsx` (route `/live-steering`, permission `steering.summary.read`).
Titled **Current Expected DNS Steering**. It renders RADAR's **persisted** expected-steering
state and events — it does **not** evaluate in the browser and never re-implements the
engine.

## Data flow (poll `/events` only)
1. Load `/live-steering/config` once → ISP scenarios, reason vocabulary, `maxSelectableIsps`
   (6), poll intervals (`15/30/60`, default 30), `highlightSeconds` (10). Seed the initial
   selection (first two ISPs) and interval from it.
2. Load `/live-steering/state?isp=…` per selected ISP (per-ISP, so one failure is isolated).
3. **Poll only `/live-steering/events`** on the chosen interval. The first poll **primes**
   the cursor from the backlog **without highlighting** (a reload never re-highlights old
   changes). Each subsequently-arriving event that targets a **selected** ISP refreshes that
   card from the event's own `currentState` and highlights it for 10 s.

An ISP's state is refreshed **only when a relevant event arrives** (or on manual refresh) —
never on a blind timer, and never for an unaffected ISP.

## Per-ISP card
`ISP/ASN → Identity source → NS1 steering result (filter chain) → Eligible platforms →
Expected DNS distribution → Preferred Réalta path (CONFIGURED) → Cloudflare Load Balancer`.
Measured delivery is always **Telemetry not connected** (PNI/INEX/transit utilisation and
actual CDN traffic share). Partial evaluations show *— (partial)* and never assert a
platform.

## Change highlight
On a new event the affected card gets the `changed` class for 10 s and a notice with the
**reason label**, previous→current summary, **checksum before→after** and the event time.
Unaffected ISPs do not highlight. Animation respects `prefers-reduced-motion`: when the user
prefers reduced motion the root carries `reduce-motion` and the card gets `no-animate`, so
the pulse animation is suppressed (border emphasis remains).

## Recent Steering Changes
A table of the **persisted** events (newest first, `reasonLabel`, previous→current) — not a
browser-only log, so it is identical across reloads and replicas.

## Controls & freshness
Pause/resume, manual **Refresh now** (re-reads state for selected ISPs and polls events),
interval selector, last-successful-poll time, and a **stale** badge shown after
`interval × 2` without a fresh poll **or** after a polling failure. A principal lacking
`steering.summary.read` sees an access notice instead of the view.

See [../api/live-steering.md](../api/live-steering.md) and
[../architecture/live-steering.md](../architecture/live-steering.md).

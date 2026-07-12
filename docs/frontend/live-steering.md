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
Partial evaluations show *— (partial)* and never assert a platform.

### Network-path telemetry (read-only, informational)
Below the path, the card joins the ISP's preferred path (`Eir PNI` / `Virgin / Liberty PNI` /
`INEX` / `Transit`) to read-only utilisation from `GET /api/v1/telemetry/network-paths` (via
`useNetworkPaths`, refreshed ~hourly). It shows the observed utilisation + status badge, and
the **configured** capacity/target (kept distinct from observed), freshness and source.
Honesty rules:

- **disabled** → *Telemetry not connected*;
- **stale** → last value shown with a **STALE** label;
- **unavailable** → *Unavailable* (no invented value);
- **fresh** → observed utilisation + status (healthy / above target / warning / critical).

Engineering detail (interface, thresholds, warnings) shows only with `ns1.detail.read`. A
notice states *"Network telemetry is currently informational. RADAR is not automatically
modifying NS1 steering."* **Actual CDN traffic share** remains **Telemetry not connected**
(RADAR does not ingest delivered-traffic telemetry).

### Three tiers (never merged)
Each ISP card is now explicitly structured into three labelled tiers so prediction,
observation and traffic are never confused:

1. **Predicted DNS steering** — the persisted engine evaluation (identity, filter chain,
   eligible platforms, expected distribution, preferred path) plus the informational
   network-path and Réalta delivery context below.
2. **Observed DNS answer** (`DnsObservationTier`, from `useDnsObservation` → `/dns-observation/
   state`) — what a resolver actually returned: comparison status (match / partial / mismatch /
   confidence-low / unavailable), observed answers, resolver queried, ECS used/not, confidence,
   TTL, latency, freshness, and (with `ns1.detail.read`) the typed differences + explanation. A
   **Run DNS observation** button (gated on `dns.observed.run`) triggers a manual observation.
   When an observation changes (answer set, match status, ECS, resolver, TTL or confidence) the
   tier highlights for 10s in a **distinct teal** style — separate from the steering-change
   highlight — respecting `prefers-reduced-motion`, and it never claims traffic changed.
3. **Actual traffic / experience** — **Telemetry not connected** (actual CDN share, POP
   selection and QoE are not measured).

A notice states RADAR shows these three separate tiers and that a single DNS observation is one
sample, not proof of the distribution or of traffic.

### Réalta delivery context (cache pools + origin)
When Réalta is an eligible platform for the ISP, the card also renders a compact **Réalta
delivery context** from `GET /api/v1/telemetry/cache-pools` + `/origin` (via
`useCacheTelemetry`): aggregate pool health (worst status), configured aggregate capacity,
aggregate headroom (`n/a` if any pool's headroom is unavailable), and origin health — with
the explicit **responsibility boundary**: *NS1 selects Réalta · Cloudflare selects the pool ·
RADAR observes pool & origin telemetry (does not control Cloudflare or NS1).* A notice states
*"Cache and origin telemetry are informational. RADAR is not automatically modifying NS1 or
Cloudflare."* The full per-pool / per-node tables live on the Dashboard and Topology.

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

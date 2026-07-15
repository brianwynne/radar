# CloudVision network telemetry (read-only)

RADAR's first **operational telemetry source** for the future Traffic Policy Controller
([ADR-0002](../adr/0002-traffic-policy-controller.md)). It connects RADAR to Arista
CloudVision, retrieves live edge-router state, normalises it into a **vendor-neutral canonical
model**, and presents it in the Network Telemetry dashboard. It is **strictly read-only** — no
device, CloudVision or NS1 write path exists — and it never fabricates a value: an absent or
stale reading is surfaced as such.

> Scope: this is the *telemetry platform* only. No traffic steering, optimisation, weight
> calculation or NS1 write is part of it (those are later phases in ADR-0002's roadmap).

## Flow

```
Arista edge routers → CloudVision streaming telemetry → CloudVision read-only API
   → CloudVision client (transport only)  → adapter (all business logic)
   → canonical NetworkStateSnapshot → poller (latest + bounded history)
   → /api/v1/network/* → Network Telemetry dashboard
```

The separation is deliberate and enforced (it mirrors the existing NS1 + Prometheus-telemetry
subsystems):

- **Client** (`cloudvision/http-client.ts`, `mock-client.ts`) — authentication, connectivity,
  retries, pagination, timeouts, transport errors. **No business logic.** CloudVision wire
  shapes never leave this layer.
- **Adapter** (`cloudvision/adapter.ts`) — mapping, unit conversion, interface classification,
  throughput/utilisation/headroom, freshness, aggregation, completeness and warning generation.
  Pure and deterministic given an injected clock.
- **Canonical model** (`cloudvision/types.ts`) — `NetworkDevice`, `NetworkInterface`, `BgpPeer`,
  `LinkGroupState`, `NetworkStateSnapshot` (+ `NetworkSummary`, `Completeness`). The rest of
  RADAR depends only on these.

## CloudVision APIs used

Only supported, documented CloudVision APIs are used; the UI is never scraped and no
undocumented endpoint is called. Every request is a `GET` carrying `Authorization: Bearer
<service-account-token>`.

| Data | API | Endpoint | Status |
|---|---|---|---|
| Device inventory | Resource API (gRPC + REST gateway) | `GET {endpoint}/api/resources/inventory/v1/Device/all` | **Confirmed** from the `arista/inventory.v1` service swagger (`aristanetworks/cloudvision-apis`). Returns device id, hostname, model, software version, streaming status. |
| Interface state / counters / speed | NetDB telemetry (REST) | `GET {endpoint}/api/v1/rest/{deviceId}/Smash/interface/status/eth/phy/slice/1/intfStatus` | **Grounded, pending live confirmation.** Interface/BGP are NetDB state (there are no `interface`/`bgp` Resource-API packages). Exact Sysdb/Smash paths are deployment/version-specific. |
| BGP peers | NetDB telemetry (REST) | `GET {endpoint}/api/v1/rest/{deviceId}/Sysdb/routing/bgp/export/vrf/default/peerInfoStatus` | **Grounded, pending live confirmation.** |

Because the NetDB paths are not yet confirmed against a live CVP instance, the live mapping is
**tolerant**: any field the live payload does not provide is surfaced as `UNAVAILABLE`, never
invented. Mock mode is fully implemented and tested; the live path is exercised end-to-end by
the validation command once a service account is available (same pattern RADAR uses for NS1).

## Interface classification

Configuration-driven and RADAR-owned (`cloudvision/classification.ts`): a device never dictates
its provider or link-type. Rules are tried most-specific-first and the first match wins:

1. **exact device + interface** (`{ kind: 'device_interface', deviceId, interface }`)
2. **exact description** (`{ kind: 'description_exact', description }`)
3. **description regex** (`{ kind: 'description_regex', pattern, flags }`)
4. otherwise **UNKNOWN** — the interface stays fully visible and is counted; it is never
   silently discarded, so operators can see and then classify it.

Link types: `PRIVATE_PEERING`, `IX_PEERING`, `TRANSIT`, `INTERNAL`, `UNKNOWN`. Defaults live in
`classification-rules.ts` (illustrative RTÉ edge: Eir PNI, INEX IX, Liberty, Transit, internal);
a deployment overrides them with a JSON file via `CLOUDVISION_CLASSIFICATION_FILE`.

## Throughput

`cloudvision/throughput.ts`. Bandwidth is **preferred from what CloudVision reports directly**
(`REPORTED`); where unavailable it is **derived from octet counters across two samples**
(`DERIVED`); otherwise `UNAVAILABLE`. Derivation is defensive and yields `UNAVAILABLE` (never a
guess) for: counter rollover across a device **reboot** (counters reset), duplicate/backwards
timestamps, zero intervals, missing samples, and unrealistic spikes (above interface speed
+10%, or an absolute ceiling when speed is unknown). Counter maths use `bigint` so 64-bit wrap
is exact. Utilisation = `primaryBps / speedBps`; headroom = `speedBps − primaryBps` (clamped ≥0).

## Aggregation

Link groups (provider cards) and the snapshot summary. **Aggregate utilisation is always
total-throughput / total-capacity — never an average of per-interface percentages.** Capacity
and headroom count only operationally-**up** members (a down link contributes no available
capacity). The summary reports total edge / peering / transit throughput, operational capacity
and headroom, unhealthy link and BGP counts, and unknown-interface count.

## Freshness & completeness

Every object carries a 4-level **freshness** (`FRESH` ≤ window, `DEGRADED` ≤ 2×, `STALE` beyond,
`UNAVAILABLE` when there is no observation; window = `CLOUDVISION_MAX_SAMPLE_AGE_SECONDS`). The
snapshot also reports **completeness** (`complete`/`partial`/`empty`) from observed-vs-expected
devices and interfaces-with-bandwidth. Stale data is never presented as current.

## Runtime (poller)

`cloudvision/poller.ts`. Self-rescheduling (default 10s), prevents overlapping polls, backs off
exponentially on repeated failures, keeps the latest snapshot plus a **bounded in-memory history
ring buffer** (default 720 points ≈ 2h; no persistence), and **preserves the last good snapshot
on failure**. Exposes connector status (running, last poll/success, duration, failures, snapshot
age, counts). Observability is structured pino logs (poll-duration and failure counts as
fields) — matching RADAR's house style; there is no separate metrics registry.

## Dashboard

`apps/web/src/pages/NetworkTelemetry.tsx` at `/network` (permission `topology.summary.read`).
Summary tiles, dependency-free inline-SVG sparkline trends, provider cards, a filterable
interface table, and a BGP table. Auto-refreshes every 10s, flags mock-vs-live and stale
telemetry, and shows configured facts distinctly from observed values. (RADAR ships no charting
library; the sparklines are self-contained SVG per the one-architecture mandate.)

## Mock mode

`CLOUDVISION_MODE=mock` requires **no credentials** and drives the **same adapter and APIs** as
live. Scenarios (`CLOUDVISION_MOCK_SCENARIO`, `cloudvision/fixtures.ts`): `normal`,
`major-event`, `eir-near-capacity`, `inex-failure`, `transit-failure`, `bgp-failure`, `stale`,
`counter-reset`, `missing-speed`, `partial-response`, `auth-failure`.

## Validation command

`npm run -w @radar/api cloudvision:validate` (`cloudvision/validate.ts`) — see
[docs/operations/cloudvision.md](../operations/cloudvision.md#validation). Read-only; exits
non-zero on authentication failure, missing routers, missing critical interfaces, schema
incompatibility, or critically stale telemetry.

## Security

The service-account token is read from `/run/secrets/cloudvision_token` first, then
`CLOUDVISION_TOKEN`, is held in memory only, and is **never logged or returned** in any API
response. The endpoint URL, token and raw wire bodies never appear in `/api/v1/network/*`
responses. HTTPS is required for the live endpoint outside development. The connector has **no
write capability of any kind**. See [docs/operations/cloudvision.md](../operations/cloudvision.md).

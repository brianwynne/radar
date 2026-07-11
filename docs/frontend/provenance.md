# RADAR Frontend — Data Provenance in the UI

RADAR must never let a viewer mistake synthetic, configured, or derived data for live
production measurement. The UI encodes provenance at three levels.

## 1. Source mode (mock vs live)
- A global banner (from `GET /api/v1/ns1/config`) states **MOCK MODE — data is SYNTHETIC
  and NON-PRODUCTION** or **LIVE**.
- Every NS1-derived response carries a `provenance` object (`mode`, `synthetic`,
  `readOnly`, `endpoint`, `retrievedAt`, `disclaimer`) rendered by `ProvenanceLine`, and a
  `SyntheticTag` badge (`MOCK · SYNTHETIC` / `LIVE`).

## 2. Configured / manually-maintained values
Topology capacities, targets, and ASN→path mappings are **RADAR-configured**, not
measured. Each is badged `CONFIGURED` or `MANUALLY MAINTAINED`. Examples:
- Donnybrook: 4 caches, ~80 Gb/s each, ~320 Gb/s aggregate — *manually maintained*.
- External Pool 1 & 2: 4 caches each, ~700 Gb/s outbound — *manually maintained*.
- Preferred PNI utilisation target: 70% — *configured*.

## 3. Telemetry not connected
Every node/link that would have a measured utilisation shows **Utilisation: Telemetry not
connected** plus its **expected future source** (Varnish telemetry, router/interface
telemetry, Cloudflare API, network/monitoring adapter). The UI **never generates a sample
utilisation percentage**.

## Derived vs asserted
- **Identity** (country/ASN/network path) is *derived/configured*, labelled accordingly
  (e.g. the network path is `CONFIGURED`).
- **Expected distribution** is *probabilistic* (weighted shuffle) and always labelled so —
  never a guaranteed traffic share.
- **Partial evaluations** (unsupported filter) never assert a definitive platform or
  distribution; they are shown as **Partial**.
- **Live Steering** is titled **Current Expected DNS Steering** and every payload carries
  `provenance.label = "Current Expected DNS Steering"`. It is the persisted *expected*
  result of evaluating NS1's Filter Chain — **never actual delivered traffic**. PNI/INEX/
  transit utilisation and actual CDN traffic share remain *Telemetry not connected*.
- **Steering-change reasons** are attributed from a fixed vocabulary; an unexplainable
  change is labelled *"Reason not yet attributable"* rather than inventing a cause.

## Responsibility boundary
Provenance also covers *who decides what*: NS1 selects the delivery platform; Cloudflare
selects the Réalta pool. The UI states this wherever a platform or pool is shown, so a
platform decision is never attributed to Cloudflare, nor a pool decision to NS1.

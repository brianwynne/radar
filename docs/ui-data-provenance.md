# RADAR UI Data Provenance Register

A core RADAR principle: **an engineer must always know where every displayed value
originates.** Every field shown anywhere in RADAR has an explicit provenance. This
register is the source of truth; the UI renders a provenance/freshness chip for every
panel derived from it.

## Classifications

| Class | Meaning | Trustworthy in v1? |
|---|---|---|
| **Received** | Arrived in the DNS request (resolver IP, ECS, QNAME, QTYPE). | Yes |
| **Derived** | Computed by the RADAR engine from received + configured data (identity, filter trace, expected distribution, effective-policy interpretation). | Yes |
| **Configured** | Read from NS1 (read-only GET): answers, weights, priorities, meta, filters, monitors, TTL, raw JSON. | Yes |
| **Manual (Topology)** | Entered by an Engineer in RADAR (PNI/INEX/transit names + capacities + targets, cache-pool definitions, friendly names, thresholds, annotations). Static in v1. | Yes (as declared config, not live) |
| **Operational (Telemetry)** | Live observed state from a telemetry adapter. **Not connected in v1** — panels are present but show "Telemetry Not Connected" (see below). | **No — deferred** |
| **Simulated** | Engine output under scenario overrides (what-if). | Yes (config-driven); util deltas need telemetry |
| **Stored** | Persisted RADAR state in PostgreSQL (snapshots, evaluation runs, audit). | Yes |

## Telemetry panels (decision §3)

Telemetry panels are deliberately present in v1 to architect the UI around the complete
delivery platform, but must clearly indicate telemetry is not yet connected, e.g.:

```
PNI: Eir        Utilisation: Telemetry Not Connected
Target: 70%     Source: Future Network Adapter
```

Applies to: PNI, INEX, Transit, Cache Pools, Cache Nodes, Origin, QoE, Capacity, Health.

## Field register

Legend for **Update Method**: `request` (per DNS request), `engine` (computed on
evaluation), `ns1-get` (NS1 read), `manual` (Engineer edit), `adapter` (future
telemetry), `stored` (Postgres).

| Field | Source system | Classification | Update method | Confidence (v1) | Future source |
|---|---|---|---|---|---|
| Domain / QNAME | DNS request | Received | request | high | — |
| Type / QTYPE | DNS request | Received | request | high | — |
| Resolver IP | DNS request | Received | request | high | — |
| ECS present / subnet | DNS request | Received | request | high | — |
| Identity Source (ECS/Resolver) | RADAR engine (from `use_client_subnet` + ECS) | Derived | engine | high | — |
| Country | Geo of evaluated address | Derived | engine (v1: scenario-supplied) | ECS→medium, resolver→low | Geo adapter (MaxMind / NS1 Pulsar) |
| ASN | ASN of evaluated address | Derived | engine (v1: scenario-supplied) | as country | ASN/RIR adapter |
| Network name | ASN → name | Derived | engine (v1: supplied/mapped) | low | ASN adapter + RADAR labels |
| Prefix | ECS subnet or client prefix | Derived/Received | engine | medium | RIR adapter |
| Confidence | RADAR engine | Derived | engine | high | — |
| Delivery-platform answers / rdata | NS1 | Configured | ns1-get | high | — |
| Answer weight / priority / meta | NS1 | Configured | ns1-get | high | — |
| Filter Chain (order, types, config) | NS1 | Configured | ns1-get | high | — |
| Monitors / health checks (config) | NS1 | Configured | ns1-get | high | — |
| Answer up-state | NS1 monitor/feed | Configured | ns1-get | medium (feed-driven; assumed up in v1) | NS1 monitor feed adapter |
| Raw NS1 JSON / checksum / retrieval time | NS1 → Postgres | Configured / Stored | ns1-get / stored | high | — |
| Decision path / filter trace / retained-removed | RADAR engine | Derived | engine | high (partial if unsupported filter) | — |
| Expected steering distribution (donut, %) | RADAR engine (from weights) | Derived | engine | high, **probabilistic** | — |
| Effective Policy (e.g. "IE-Eir-Residential") | RADAR interpretation of NS1 config | Derived | engine | medium | — |
| PNI / INEX / Transit name | RADAR topology | Manual (Topology) | manual | high (declared) | — |
| PNI / INEX / Transit capacity & target | RADAR topology | Manual (Topology) | manual | high (declared) | — |
| PNI / INEX / Transit **utilisation** | Network telemetry | Operational | adapter | **not connected** | Future Network Adapter |
| Cache-pool / cache-node definitions & counts | RADAR topology | Manual (Topology) | manual | high (declared) | Cloudflare adapter (live inventory) |
| Cache-pool / node **health, CPU, throughput** | Cache telemetry | Operational | adapter | **not connected** | Cloudflare / Varnish telemetry |
| Cloudflare pool selection | Cloudflare | Operational | adapter | **not connected** | Cloudflare adapter |
| Origin **health / load / capacity** | Origin telemetry | Operational | adapter | **not connected** | Origin telemetry adapter |
| QoE | Youbora | Operational | adapter | **not connected** | Youbora adapter |
| Delivery-platform health (dashboard) | NS1 monitor state (partial) | Configured / Operational | ns1-get / adapter | partial | Platform health adapters |
| DNS Queries (24h) | Traffic analytics | Operational | adapter | **not connected** | NS1 analytics / QPS adapter |
| Cache Hit Ratio | Cache telemetry | Operational | adapter | **not connected** | Cache telemetry |
| Origin Load | Origin telemetry | Operational | adapter | **not connected** | Origin telemetry |
| Alerts | RADAR alerting | Operational | adapter | **not connected** | RADAR alert engine + telemetry |
| Per-ASN distribution / platform (Traffic) | RADAR engine (per-ASN evaluation) | Derived | engine | high | — |
| Per-ASN PNI/transit path (Traffic) | RADAR topology mapping | Manual (Topology) | manual | high (declared) | — |
| Per-ASN utilisation / status (Traffic) | Network / health telemetry | Operational | adapter | **not connected** | Network + health adapters |
| Simulation result distribution | RADAR engine (overrides) | Simulated | engine | high | — |
| Simulation utilisation deltas | RADAR engine + baseline telemetry | Simulated / Operational | engine + adapter | partial (relative only) | Network adapter for absolute baseline |
| Recommendations (simulation) | RADAR heuristics | Derived | engine | medium | — |
| Snapshots (source, resource, time, payload, canonical, checksum, created_by, label, endpoint) | RADAR → Postgres | Stored | stored | high | — |
| Audit events | RADAR → Postgres | Stored | stored | high | — |

## Rule for new UI fields

No field ships without a row here. If a field's provenance is Operational and the
adapter does not exist, the panel renders with the **Telemetry Not Connected** treatment
and a `Future source` label — never a fabricated value.

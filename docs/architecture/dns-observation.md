# Tier-2 active DNS observation — architecture

RADAR verifies what a configured resolver **actually returns** for a watched record and
compares it with RADAR's **predicted** NS1 evaluation. This is the middle tier between
"predicted DNS steering" (from configuration) and "actual traffic" (never measured). RADAR
stays the **analysis / correlation plane**: it issues read-only DNS queries only — no
NS1/Cloudflare writes, no HTTP/video/traceroute/QoE probes, no packet capture, no third-party
monitoring integrations, and no automatic remediation.

## Three tiers (never merged)
1. **Predicted DNS steering** — RADAR's engine evaluates the NS1 Filter Chain for an ISP
   identity → the expected eligible set + distribution.
2. **Observed DNS answer** — a configured resolver is queried; the actual answer set, TTL,
   response code, ECS behaviour and latency are recorded and compared with (1).
3. **Actual traffic / experience** — **Telemetry not connected**. Querying a resolver is not
   the same as being on-net; once a client connects, the CDN sees its real source IP, so
   POP/edge selection, cache behaviour and QoE cannot be inferred from DNS.

## Why one observation is not proof
- A resolver result represents the **resolver**, not necessarily all subscribers. RADAR
  attaches a **confidence** (`high` ECS honoured + representative subnet; `medium` direct ISP
  resolver; `low` public/shared/uncertain; `unknown` insufficient evidence) and never asserts
  a match/mismatch at low/unknown confidence (→ `confidence_low`).
- With probabilistic ordering (Weighted Shuffle) or a `select_first_n` terminal, a single
  response is one **sample** of the distribution. RADAR compares the observed answers against
  the eligible **pool**, never against the theoretical shares as if one sample proved them,
  and never treats answer-order differences as a steering mismatch for probabilistic records.

## Adapter boundary
The domain/UI depend only on `DnsObservationClient`; implementations are `Disabled`, `Mock`
(deterministic synthetic), and `Resolver` (real). The resolver client uses an injectable
`DnsTransport` — the only networked part is `UdpDnsTransport` (a single read-only UDP query
via a small dependency-free DNS wire codec that handles A/AAAA + EDNS0 Client-Subnet). All
comparison/confidence logic is transport-independent and unit-tested without network.

## Comparison
`compareObservation(predicted, observed, scenario)` yields a `ComparisonStatus`
(`match` / `partial_match` / `mismatch` / `observation_unavailable` / `confidence_low` /
`unknown`) plus typed differences: `same_set_different_order`, `missing_predicted_answer`,
`unexpected_observed_answer`, `ttl_difference`, `ecs_discrepancy`, `resolver_only_observation`,
`partial_radar_evaluation`, `unsupported_record_filter`, `no_response`, `dns_error_response`.
Between consecutive observations, `classifyObservationChange` attributes an
`ObservationChangeReason` (observed-answer/match/ecs/resolver/ttl/confidence/availability) —
used only for the observed-DNS highlight, and it never claims traffic changed.

## Scenarios & scheduling
Central ISP scenarios (`scenarios.ts`): Eir, Virgin/Liberty, Vodafone, Three, Sky — with
resolver addresses and representative ECS subnets that are **RFC 5737 placeholders** until RTÉ
supplies confirmed endpoints (never invent real ones). Observation is **manual by default**;
optional periodic observation is OFF by default, with a 60s interval floor, bounded
concurrency, per-ISP failure isolation and exponential backoff — no aggressive probing.

## Persistence (migration `0003_dns_observations`)
Only a **bounded history** is stored: one row per observation with observed/predicted answers,
comparison status, confidence, TTL, latency, ECS status, record checksum, explanation,
warnings and provenance. No tokens, credentials, NS1 keys, packet captures or raw resolver
logs are ever stored. No high-frequency raw telemetry is persisted; the app is stateless apart
from its existing PostgreSQL data.

## Out of scope
No NS1 writes, Cloudflare writes, HTTP/video/traceroute/QoE probes, RIPE Atlas / ThousandEyes
/ Catchpoint integrations, packet capture, or automatic remediation.

See [../api/dns-observation.md](../api/dns-observation.md),
[../frontend/live-steering.md](../frontend/live-steering.md) and
[../ns1/assumptions.md](../ns1/assumptions.md).

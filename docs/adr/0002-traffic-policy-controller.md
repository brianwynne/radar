# ADR-0002 — From explainability to closed-loop control: the Traffic Policy Controller

- **Status:** Proposed
- **Date:** 2026-07-15
- **Supersedes/extends:** [ADR-0001](0001-architecture.md) (read-only-first). This ADR opens
  the write path that ADR-0001 and `docs/architecture/rollback.md` deliberately reserved.
- **Full design:** [docs/design/traffic-management-platform.md](../design/traffic-management-platform.md)

## Context

RADAR v1 reads NS1 and *explains* steering. The operational reality it explains is a DNS
configuration that has grown organically for years: hundreds of ASN-specific rules, static
weights, manual changes, and one CCV-threshold automation. It works, but the intelligence is
frozen into static config with no memory of *why*, and NS1 itself is blind to the operational
state of infrastructure RTÉ owns (edge routers via CloudVision, Réalta caches, origin, peering).

We now have rich read-only telemetry (CloudVision, Youbora, CCV, origin/cache, event schedule).
The question is not "how do we automate today's config" but "what should the architecture become."

## Decision

Introduce a **Traffic Policy Controller (TPC)** as a new RADAR subsystem that computes the
*desired* NS1 policy from live operational state, and let NS1 remain the fast, global, dumb
*enforcement* layer. We separate three concerns that today's NS1 config conflates:

1. **Intent** — declarative policy in Git (objectives, constraints, topology facts, modes).
2. **Decision** — a **pure, deterministic function** `decide(State, Policy) → DesiredNS1State`,
   emitting a persisted, replayable **Decision Record** for every tick.
3. **Enforcement** — NS1, driven by a reconciler that applies the minimal diff.

Four load-bearing commitments:

- **Deterministic, not ML.** The decision is a constrained allocation with a fixed,
  auditable objective order. No learned models in the decision path.
- **Safety system first, optimiser second.** Hard envelopes (origin/cache/peering/QoE) are
  **lexicographic** constraints the optimiser cannot trade away; cost/locality are optimised
  only *within* the safe region.
- **DNS is a slow, coarse actuator.** The controller steers on *headroom and leading
  indicators*, is heavily damped (hysteresis, minimum dwell ≫ TTL, rate-limited deltas), and
  only ever controls the *marginal* (new-session) distribution.
- **Advisory before autonomous.** The TPC ships first in **shadow/advisory** mode (recommends;
  humans apply) and earns write authority incrementally, always within a pre-approved envelope,
  with a break-glass freeze.

## Alternatives considered

- **Automate the current config as-is** (turn each ASN rule into a scripted edit). Rejected:
  entrenches the debt, keeps the intelligence in the DNS layer, and cannot reason across
  objectives. See design §1.
- **Real-time reactive control on observed overload.** Rejected: DNS dead-time (TTL + resolver
  caching) means reactive control always fights the last battle and oscillates. See design §4, §7.
- **Weighted-sum multi-objective optimiser.** Rejected: a blended score can trade viewer QoE
  for cost. Unacceptable for a national broadcaster; we require lexicographic priority. See §7.
- **ML/RL traffic optimiser.** Rejected per the explicit mandate: not explainable, not
  reproducible, unsafe for live national events. Determinism is a feature, not a limitation.

## Consequences

- A **new, separately-credentialed write-capable NS1 adapter** is introduced (never the v1
  GET-only client; ADR-0001's key-isolation rules extend to it). Read and write credentials
  stay distinct.
- Every applied change is a Git-versioned desired state + a recorded transition ⇒ **rollback =
  re-apply last known-good**. **Drift = live NS1 ≠ last applied desired state ⇒ alarm.**
- RADAR's explainability discipline now covers the write path: **policy is version-controlled;
  decisions are logged; both are diffable and replayable.**
- Simulation and production share the same decision function ⇒ "what happens if…" is the
  controller run against a synthetic/forecast state, with guaranteed fidelity.
- The provenance rule holds: **NS1 selects the delivery *platform*; Cloudflare selects the
  Réalta pool; caches are downstream.** The TPC acts only at the platform-weighting layer and
  never attributes pool/cache behaviour to NS1.

## Non-goals (this ADR)

No ML in the decision path. No control of the Cloudflare→pool layer. No bypass of the
break-glass freeze. No autonomous write authority before the advisory phase has demonstrably
earned it (design §10, phases 5→6).

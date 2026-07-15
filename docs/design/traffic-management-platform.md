# RADAR — Intelligent Traffic Management Platform (design)

> **Status:** design proposal · **Decision:** [ADR-0002](../adr/0002-traffic-policy-controller.md)
> · extends [ADR-0001](../adr/0001-architecture.md)
>
> This document evolves RADAR from *reading and explaining* NS1 steering into the intelligence
> layer that *decides* it. It is the write-path effort that `docs/architecture/rollback.md`
> reserved. RADAR finally earns the **R** it was named for: from *Analysis* to *Analysis **and
> Routing***.

## 0. Thesis (read this first)

Today the NS1 configuration is simultaneously the *intent*, the *intelligence* and the
*mechanism*. Every ASN rule is a human decision, made at a point in time, for a reason that is
no longer written down, frozen into config that NS1 executes blindly. That conflation is the
root cause of every symptom in §1.

The target architecture separates the three:

```
   Operational telemetry (CloudVision, Youbora, CCV, origin/cache, schedule)
        │            [ Traffic State Model — canonical, timestamped, provenance-tagged ]
        ▼
   Traffic Policy Controller        decide(State, Policy) → DesiredNS1State   (PURE, DETERMINISTIC)
        │                           + Decision Record (why, replayable)
        ▼
   Traffic Policy (Git)             intent, constraints, modes, topology facts  (SOURCE OF TRUTH)
        ▼
   NS1                              fast, global, dumb ENFORCEMENT  (weights/filters)
        ▼
   DNS responses → CDN
```

Four commitments carry the whole design; everything below is a consequence of them.

1. **The controller is a safety system that happens to optimise** — not an optimiser that
   happens to be safe. Its first job is to keep RTÉ-owned infrastructure and viewer QoE inside
   safe envelopes. Cost and locality are optimised *only within* the safe region.
2. **DNS is a slow, coarse actuator.** TTL + resolver caching + client caching give the control
   loop dead-time measured in minutes. You cannot turn a dial in real time. Therefore the
   controller steers on **headroom and leading indicators**, is **heavily damped**, and controls
   only the **marginal (new-session) distribution** — never the installed base.
3. **Determinism over ML.** `decide()` is a pure function; every output is reproducible from a
   named State snapshot and a named Policy version. This makes decisions explainable *and* makes
   simulation share the exact production engine.
4. **Advisory before autonomous.** Write authority is earned incrementally, always inside a
   pre-approved envelope, always behind a break-glass freeze.

---

## 1. Review of the current NS1 architecture

**Current shape:** `Client → NS1 (country/ASN/prefix filters, weighted-shuffle, select-first-N,
health, static weights) → CDN`, plus manual changes and one automation (enable commercial CDN
when CCV crosses a threshold).

### Strengths (keep these)
- **NS1 as enforcement is correct.** Global anycast, health-checked, battle-tested. We are *not*
  replacing it — a national broadcaster should not put a bespoke service in the DNS hot path.
- **Filter-chain model is expressive and already explainable** — RADAR's engine evaluates it
  deterministically (`@radar/engine`, `ExpectedDistribution`). That primitive is reused, not
  discarded.
- **The CCV automation shows the right instinct:** couple delivery to a live signal. Wrong
  variable and wrong mechanism (see below), right direction.

### Weaknesses, and *why they occur*
| Symptom | Root cause |
|---|---|
| **Hundreds of ASN rules** | Each is a *decision cache entry* whose provenance was never recorded. The config accretes because there is no layer that can *derive* per-ASN steering from facts, so humans enumerate it by hand. |
| **Static weights** | A weight is only correct at the audience level it was tuned for. `70/30 Réalta/Fastly` at normal load can be catastrophic at 3× audience. Constants encode a single operating point of a system that never sits still. |
| **Limited operational awareness** | NS1 sees "is the answer up?" It cannot see Réalta at 95% CPU, or the Eir PNI at 68% and climbing. The intelligence is blind to the infrastructure RTÉ actually owns. |
| **Manual changes under load** | Because the only actuator is hand-editing config, the highest-stakes changes happen at the worst possible time, by a human, without a dry-run. |
| **CCV-threshold automation** | A step function on one proxy variable. CCV is a proxy for load; the proxy breaks in unusual events (low CCV but origin-heavy, or high CCV comfortably cached). It should be an *input to* a continuous headroom-driven decision, not the trigger. |

### Operational risk / scalability / maintainability / hidden debt
- **Oscillation & thundering-herd risk:** manual weight flips interact with TTL dead-time; a
  correction applied during overload lands minutes later, often after the situation reversed.
- **Change risk is unbounded:** no blast-radius limit, no canary, no automatic rollback. One
  fat-fingered weight during a live national event is a national incident.
- **The config does not scale with objectives.** Adding "prefer ISP-local delivery" or "cap
  commercial CDN spend" means threading new logic through hundreds of rules by hand.
- **Hidden debt = lost provenance.** The most dangerous debt is not the rule count; it is that
  nobody can say *why* a given ASN is pinned. Removing a rule is scary because its purpose is
  unknown. The design's first job is to make intent explicit and derivation automatic.

> **Design stance:** do not automate this configuration. Replace the *conflation*. Turn
> hundreds of rules into a handful of **intents** plus a **topology fact base**, and let the
> controller derive the rest.

---

## 2. The Traffic State Model

A **canonical, immutable, timestamped snapshot** of the whole delivery system, assembled every
tick from the telemetry adapters. It is the single input surface to `decide()`.

### Design properties
- **Immutable + content-addressed.** Each snapshot is hashed (`stateHash`). A decision references
  the exact hash it consumed ⇒ perfect reproducibility and replay.
- **Provenance and freshness are first-class**, reusing RADAR's existing
  `SampleProvenance` / `TelemetryFreshness` / `TelemetryStatus` (already in
  `apps/api/src/telemetry/*`). Every field knows *where it came from, when, and whether it is
  stale*.
- **Staleness degrades safely.** A stale or missing input never reads as "healthy." It sets a
  per-field `confidence` and, past a threshold, forces the controller into a conservative posture
  (protect owned infra, lean on commercial CDN, never over-commit Réalta on stale data). Fail
  safe, not fail optimistic.
- **Source-agnostic.** Fields are defined by meaning, not by CloudVision/Youbora/Prometheus
  wire shape; adapters normalise into the model (the RADAR adapter pattern from ADR-0001).

### Shape (illustrative)
```ts
interface TrafficStateSnapshot {
  stateHash: string;               // content hash of the normalised snapshot
  capturedAt: string;              // ISO; the tick time
  network: {                       // from CloudVision (Arista) — read-only streaming
    interfaces: Array<{ id; role: 'peering'|'transit'|'core'; utilisation; capacityGbps;
                        headroomGbps; operState: 'up'|'down'; }>;
    peering: Array<{ asn; exchange: 'INEX'|'PNI'|…; utilisation; headroomGbps; }>;
    transit: Array<{ provider; utilisation; headroomGbps; }>;
    bgp: Array<{ neighbour; state: 'established'|…; routesReceived; }>;
    linkFailures: Array<{ interfaceId; since; }>;
  };
  rteCdn: {                        // Réalta: cache + origin telemetry (existing adapters)
    throughputGbps; cacheUtilisation; cacheHitRatio;
    originRequestRate; originUtilisation; internalHeadroomGbps;
    pools: Array<{ id; utilisation; nodesUp; nodesTotal; }>;
  };
  commercialCdn: Record<'fastly'|'akamai'|'cloudfront',
    { utilisation; allocationCeiling; health: 'ok'|'degraded'|'down'; committedCostTier?; }>;
  viewer: { concurrentViewers; startupTimeMs; rebufferRatio; qoeIndex; };  // CCV + Youbora
  context: {                        // the feedforward inputs
    events: Array<{ id; title; startsAt; endsAt; expectedPeakCcv; tier: 'normal'|'major'|'international'; }>;
    forecastCcvCurve: Array<{ at; ccv }>;    // from historical growth + schedule
    plannedMaintenance: Array<{ target; window; }>;
  };
  freshness: Record<string, TelemetryFreshness>;   // per-source; drives confidence + degradation
  degraded: boolean;               // any critical source stale/absent → conservative mode
}
```

### Representation
- **In memory:** a plain immutable object (the pure `decide()` never touches I/O).
- **At rest:** persisted per tick in Postgres (RADAR's only durable state, ADR-0001), retained
  for replay/audit; hashed for dedup. This is the evidence base for §8 dashboards and §9 sims.
- **Derived, not raw:** the model stores *headroom* (capacity − observed) and *rates*, not just
  gauges, because the controller reasons about margin and trend, not instantaneous values.

---

## 3. The Traffic Policy Controller (TPC)

The intelligence layer. It answers exactly one question every tick: **"What is the optimal
distribution of *new viewer sessions* right now, and is that distribution *safe*?"** It does not
answer DNS requests.

### Responsibilities
1. Assemble the current `TrafficStateSnapshot` (via adapters).
2. Load the active `Policy` (Git-sourced) and resolve the active **mode** (§6).
3. Run `decide(state, policy) → DesiredNS1State` (pure; §7 algorithm).
4. Emit a **Decision Record** (below) and persist it.
5. Hand `DesiredNS1State` to the reconciler (§4) — or, in advisory mode, surface it for a human.

### Inputs / outputs
- **In:** `TrafficStateSnapshot`, `Policy` (version-pinned), current live NS1 state (for diffing),
  operator overrides (§ below), the previous decision (for hysteresis/dwell).
- **Out:** `DesiredNS1State` (target weights + derived filter parameters per record/platform),
  a `DecisionRecord`, and a `PredictedEffect` (from the engine's `ExpectedDistribution` + the
  capacity model in §9).

### Decision record — the beating heart
Every tick, whether it changes anything or not:
```ts
interface DecisionRecord {
  id; at; tickSeq;
  stateHash;                 // exact input snapshot (replayable)
  policyVersion;             // exact Git policy (replayable)
  mode;                      // active operating mode + why it is active
  objectives: Array<{ name; tier; satisfied; slack; }>;   // lexicographic evaluation, §7
  bindingConstraints: string[];                            // which limits are "hot"
  chosenAllocation: Record<platform, weight>;
  diffFromCurrent: WeightDiff;                             // what changes, by how much
  predictedEffect: { perPlatformShare; peeringUtil; originLoad; commercialSpendTier; };
  safeguardsTriggered: string[];                           // hysteresis held / rate-limited / clamped
  degradedInputs: string[];                                // stale sources that shifted the posture
  rationale: string;                                       // human-readable, generated from the above
}
```
This single object answers all of §8 by construction: *what changed, why, which telemetry,
which policy, expected outcome, predicted movement.*

### Deterministic decision-making, hysteresis, safeguards
- **Pure function.** `decide()` has no clock, no randomness, no I/O. Same (state, policy) ⇒ same
  output, forever. (Randomness for weighted-shuffle lives in NS1, not here.)
- **Hysteresis bands:** do not change a weight until the deviation from ideal exceeds a band.
  Prevents chasing noise across the DNS dead-time.
- **Minimum dwell ≫ TTL:** once changed, a weight is held for a minimum period comfortably longer
  than TTL + resolver-cache, so each change fully expresses before the next.
- **Rate-limited deltas + quantisation:** weights move in bounded, meaningful steps — no 70→10
  lurches; ramp instead. Bounds the blast radius of any single tick.
- **Clamps:** hard floors/ceilings per platform per mode (e.g. Réalta never below a warm floor;
  commercial CDN never above its allocation ceiling).
- **Feasibility guard:** if no allocation satisfies the hard constraints (genuine overload), the
  controller does **not** silently violate a limit — it enters the defined triage path (§7).

### Operator overrides
- **Break-glass freeze** (highest authority): pin a named known-good `DesiredNS1State`, suspend
  the controller, log loudly. NS1 keeps serving; the loop stops touching it.
- **Bounded manual nudge:** an operator can pin/bias a platform *within* policy guardrails; the
  override is itself a versioned, audited, expiring input to `decide()` — never a raw NS1 edit
  (that would show up as drift, §5).
- **Mode pin:** force a mode (e.g. "Major Event") regardless of auto-detection.

---

## 4. NS1 integration redesign

NS1 evolves from *hand-authored source of truth* to *reconciled enforcement target*.

- **Weights become dynamic — but generated, never hand-edited.** The controller emits a desired
  weight set; a **reconciler** diffs it against live NS1 and applies the minimal change through a
  **new, separately-credentialed write adapter** (distinct from the v1 GET-only client; ADR-0001
  key-isolation extends to it).
- **Policies generate weights *and* the ASN abstraction.** Instead of hundreds of `netfence_asn`
  rules, the controller consumes **topology facts** ("ASN 2110 has a Dublin PNI, 40 Gbps, cost
  class local") + **intent** ("prefer local while peering headroom > 30%") and *derives* the
  per-ASN steering. Hundreds of rules collapse to a fact base + a policy. A rule can now be
  *explained and safely removed* because its provenance is the fact + the intent.
- **Operating modes / deployment profiles: yes** (§6). A mode is a named envelope of guardrails
  and objective weightings the controller must obey.
- **Transitions:** always **ramped**, never stepped — the reconciler applies a bounded delta per
  tick toward the target, so the marginal-session distribution slews smoothly. Mode changes widen
  or narrow the envelope; they do not teleport weights.
- **Rollback:** because every applied desired state is Git-versioned and every transition is
  recorded, rollback = *re-apply the last known-good desired state* (a fast path in the CLI/UI,
  and the automatic action on a failed health gate). No bespoke inverse logic.
- **Oscillation avoidance (the DNS-specific hazard):** hysteresis + minimum dwell ≫ TTL +
  rate-limited deltas + quantisation (§3), plus **damped feedback** (correct a fraction of the
  observed error per tick, never the whole error — critically damped, not proportional-aggressive).

---

## 5. Configuration management (Git as source of truth)

Extend RADAR's config-as-code so **Git holds intent; NS1 holds runtime.**

### Repository structure (illustrative)
```
policy/
  objectives.yaml           # ranked objectives + hard envelopes (peering/origin/cache/QoE limits)
  modes/                    # normal, high-load, major-event, international, maintenance, cdn-failure, emergency
  topology/
    asns.yaml               # facts: ASN → peering type, PNI capacity, cost class, ISP
    interfaces.yaml         # router interfaces → capacity, role
    platforms.yaml          # Réalta/Fastly/Akamai/CloudFront → ceilings, cost tiers, health probes
  guardrails.yaml           # rate limits, dwell times, clamps, blast-radius caps
generated/                  # CI output — NEVER hand-edited
  ns1-desired-state.json    # the desired weights/filters the reconciler drives toward
```

### Pipeline
1. **PR** changes intent/facts/modes (humans review *policy*, not weights).
2. **CI validation:** schema-check; static safety checks (no mode can disable all platforms; no
   ceiling below a floor); **simulate** the change against a library of stored historical states
   (§9) and fail the PR if any scenario breaches a hard envelope.
3. **Generate** candidate `ns1-desired-state.json`; **dry-run diff** vs live NS1 (reuse RADAR's
   snapshot/compare machinery, which already diffs desired vs current).
4. **Deploy:** merge → controller loads the new policy version. Policy changes are PRs; controller
   *decisions* are runtime logs (Decision Records) — **policy is version-controlled; decisions are
   logged.** Do not confuse the two.
5. **Drift detection:** continuously compare live NS1 vs last controller-applied desired state.
   Any divergence = someone edited NS1 by hand = **alarm** (reuse change-detection).
6. **Emergency changes:** break-glass path applies a pre-reviewed known-good state immediately and
   opens a retrospective PR — the change is still captured, just reviewed after the fact.

---

## 6. Operational policies (modes)

Replace static config with named **modes**, each a guardrail envelope + objective emphasis. Modes
do not contain weights; they constrain how the controller may choose them.

| Mode | Emphasis | Envelope changes (illustrative) |
|---|---|---|
| **Normal** | cost + locality within safety | standard ceilings; prefer Réalta/local; commercial CDN low |
| **High Load** | protect owned infra | lower Réalta target-util (bigger margin); pre-authorise commercial spill |
| **Major Sporting Event** | headroom + QoE | widen commercial ceilings, raise QoE floor, tighten dwell for faster (still damped) response |
| **International Event** | geo-aware capacity | emphasise transit/peering headroom for out-of-country demand |
| **Planned Maintenance** | drain a target safely | clamp the under-maintenance pool/interface to zero via ramped shift |
| **CDN Failure** | fail over cleanly | remove failed platform, redistribute within remaining safe capacity |
| **Emergency** | survive | pin conservative known-good; require human confirm for further change |

**Safe transitions:** modes are selected by explicit rules over the state (event calendar, CCV
forecast, failure signals) *or* pinned by an operator. A transition **widens/narrows the
envelope and re-runs `decide()`**; the reconciler then *ramps* toward the new target. There is no
instantaneous re-weighting — mode changes are as damped as any other change. Every transition is a
Decision Record entry ("mode → Major Event because event `X` starts in 20 min").

---

## 7. Traffic optimisation (deterministic, multi-objective)

The controller optimises several objectives at once. The **key decision is how competing
objectives are prioritised**, and the answer is **lexicographic, not weighted-sum.**

### Why lexicographic
A weighted-sum score (`0.4·QoE + 0.3·cost + …`) can *trade a little viewer QoE for a lot of cost
saving*. For a national broadcaster that is unacceptable at any exchange rate. Lexicographic tiers
make "we will never sacrifice viewer QoE for cost" a **structural guarantee**, not a tuning
artifact — and it is fully deterministic and explainable.

### Objective tiers (highest first; each tier optimised only within the feasible set left by the tiers above)
1. **Hard safety envelopes (constraints, not objectives):** origin ≤ limit, cache ≤ limit,
   peering/transit ≤ limit, per-platform health. These define the **safe region**. The optimiser
   may not leave it.
2. **Protect viewer QoE:** keep predicted rebuffer/startup within floor; never route new sessions
   to a platform predicted to breach QoE.
3. **Protect RTÉ-owned infrastructure** (Réalta caches, origin, peering) with margin.
4. **Preserve peering headroom / prefer ISP-local delivery** (the "prefer local while headroom
   allows" intent — this is where the ASN abstraction pays off).
5. **Minimise commercial CDN cost.**
6. **Operational simplicity** (tie-breaker): prefer the *smallest change* that satisfies the
   above — fewer, smaller weight moves. Stability is itself an objective.

### The algorithm
A **deterministic constrained allocation**: at each tier, choose the marginal-session split that
optimises that tier's objective subject to all higher tiers, then freeze the degrees of freedom it
fixes and descend. In practice this is a small, bounded search / linear program over a handful of
platforms with fixed coefficients — trivially fast, fully reproducible, and every binding
constraint is nameable in the Decision Record. **No learned model, no stochastic search.**

### Infeasibility (genuine overload) → defined triage, never silent violation
If tier 1 cannot be satisfied (demand exceeds total safe capacity), the controller enters an
explicit, pre-agreed **triage order** rather than "solving" the problem by breaching a limit:
protect origin above all → spill to commercial CDN even at premium cost → if still infeasible,
signal for bitrate-ladder shedding (a documented downstream lever, not an NS1 action). The point:
overload produces a *loud, explainable, pre-agreed* degradation, not a silent safety breach.

### Feedforward + feedback (because the actuator is slow)
- **Feedforward:** the event calendar + forecast CCV curve let the controller **pre-position**
  capacity/weights *before* the surge — essential given DNS dead-time. The World Cup Final is on
  the calendar; do not wait to observe the spike.
- **Feedback:** observed telemetry corrects forecast error, **critically damped** (fraction of
  error per tick) to avoid oscillation.

---

## 8. Operational dashboards

Design principle: **an operator must always be able to answer "why is the platform behaving like
this?" in under a minute.** RADAR already has the explainability UI; extend it.

Every automated decision is rendered from its Decision Record and answers, by construction:
- **What changed?** the `diffFromCurrent` weight moves.
- **Why?** the `rationale` + `bindingConstraints` (which limit was hot).
- **Which telemetry caused it?** the `stateHash` snapshot, with the specific fields highlighted
  (e.g. "Eir PNI 71% → prefer-local relaxed").
- **Which policy made it?** `policyVersion` + `mode` (+ why that mode is active).
- **Expected outcome / predicted movement?** `predictedEffect` from the engine's
  `ExpectedDistribution` and the §9 capacity model — shown *before and after*.

Core views: **Now** (live state + active mode + current weights + safe-region margin per
envelope); **Decision timeline** (every tick, filterable to "only when something changed", with
one-click replay); **Headroom** (peering/origin/cache utilisation vs limits, with forecast
overlay); **Drift & overrides** (any manual NS1 change or active operator override, loudly).
Provenance/freshness badges everywhere — a decision made on stale data must *say so*.

---

## 9. Simulation ("what happens if…")

Simulation is not a separate model — it is **`decide()` run against a hypothetical state**, so it
shares the exact production engine (the determinism dividend). Two ingredients:

1. **A state synthesiser:** build a `TrafficStateSnapshot` for the hypothetical — from a stored
   historical snapshot, or a forecast (audience curve from schedule + historical growth), or an
   injected fault (transit down, peering down, Fastly degraded).
2. **A capacity projection model** (deterministic): given a session distribution across platforms
   and a per-session bitrate/QoE model, project the resulting **origin request rate, cache load,
   and per-interface peering/transit utilisation** — the *inverse* of RADAR's existing network
   path telemetry (which platform's egress traverses which interface). This turns a proposed
   allocation into predicted utilisation.

Then **run the controller forward in time** over the synthesised state sequence and show the
sequence of decisions + predicted utilisation/QoE/cost. Because it is the same `decide()`, the
simulation of "increase Fastly allocation for Eir" or "World Cup Final" is a faithful preview of
what production *would* do.

Supported questions (all pre-deployment): raise Fastly allocation for Eir; remove an ASN
preference; transit failure; peering failure; World Cup Final; major breaking-news surge.
Predicts: traffic movement, per-CDN utilisation, peering utilisation, origin impact, commercial
CDN impact and cost tier — **before** anything is deployed. This is also the CI safety gate (§5):
a policy PR must pass a library of these scenarios without breaching a hard envelope.

---

## 10. Roadmap (each phase independently deployable, each delivering measurable value)

Mapped onto RADAR's actual state — several phases are already partly built.

| Phase | Deliverable | Where RADAR is | Measurable value |
|---|---|---|---|
| **1. Improve NS1 config** | explain steering; find dead/duplicate ASN rules | **done** (RADAR v1 explainability) | fewer rules; understood config |
| **2. Configuration as Code** | NS1 desired-state in Git; drift detection; dry-run diff | *partly* (snapshot/compare, change-detection exist) | auditable changes; no silent drift |
| **3. Policy abstraction** | replace ASN rules with topology facts + intent; controller *derives* steering | new | hundreds of rules → a fact base + a policy |
| **4. Traffic State Model** | canonical snapshot from all adapters, provenance + freshness | *adapters exist* (network/cache/origin telemetry) | one trustworthy operational picture |
| **5. Traffic Policy Controller (ADVISORY)** | `decide()` runs in **shadow**; recommends, humans apply; Decision Records | new | trust-building: compare TPC vs operator, no write risk |
| **6. Adaptive traffic management** | TPC applies **within guardrails** (closed loop); break-glass; auto-rollback | new | hands-off steady-state; faster, safer responses |
| **7. Predictive optimisation** | feedforward from schedule/forecast; pre-positioning; full simulation gate | new | ready *before* the surge, not after |

**Why advisory-first (phase 5) is the crux:** the controller runs in shadow, producing Decision
Records operators compare against what they would have done. It earns write authority (phase 6)
only after it has demonstrably agreed with good operators and its simulations have matched
outcomes. This is how you introduce automation to a national broadcaster without ever betting a
live event on unproven code.

---

## Design principles (how every choice above satisfies the mandate)

- **Deterministic** — `decide()` is pure; lexicographic objectives; no ML in the decision path.
- **Observable** — every field carries provenance/freshness; every tick emits a Decision Record.
- **Explainable** — the Decision Record answers what/why/which-telemetry/which-policy/expected.
- **Auditable** — immutable state snapshots + decision log + Git-versioned policy, all replayable.
- **Version-controlled** — Git is the source of truth for intent; NS1 is the deployed runtime.
- **Operationally simple** — stability is an explicit objective; smallest-change tie-break; modes
  keep the operator's mental model small.
- **Resilient** — NS1 keeps serving if the controller dies (holds last-good); stale telemetry ⇒
  conservative posture; feasibility guard + triage instead of silent breach.
- **Safe for live national events** — advisory-first, break-glass freeze, ramped transitions,
  blast-radius limits, CI simulation gate, automatic rollback on a failed health gate.

> **Provenance rule (unchanged from ADR-0001):** NS1 selects the delivery *platform*; Cloudflare
> selects the Réalta *pool*; caches are downstream. The TPC acts only at the platform-weighting
> layer and never attributes pool/cache behaviour to NS1.

// RADAR source-agnostic evaluation trace/result model. This is what the API and UI
// consume; no NS1 vocabulary leaks past the evaluator.

import type { DerivedIdentity, Scenario } from './identity.js';

export type AnswerDisposition =
  | 'retained'
  | 'removed'
  | 'reordered'
  | 'standby'
  | 'selected'
  | 'unsupported';

/** A config-order view of an answer, with the RADAR-friendly delivery platform. */
export interface TracedAnswer {
  id: string;
  label: string;
  deliveryPlatform?: string;
  rdata: string[];
  weight?: number;
  priority?: number;
  region?: string;
}

/** Every input answer to a step is accounted for by exactly one outcome. */
export interface AnswerOutcome {
  answerId: string;
  disposition: AnswerDisposition;
  reason: string;
  /** True when this answer was retained ONLY because it is an untagged fallback (no fence tag
   *  matched the requester, or it carries no restriction) — worth highlighting: it is serving as
   *  the safety net, not as a positive match. */
  fallback?: boolean;
}

/** How a filter acts on the answer list (NS1 guide §8.1). */
export type FilterBehaviour = 'eliminate' | 'reorder' | 'select' | 'group' | 'modify' | 'unknown';

/** Overall reliability of the local evaluation's final selection (monitoring-screen spec).
 *  - deterministic: all metadata present, no probabilistic filter — the single answer is fixed for
 *    this context.
 *  - context_dependent: the outcome hinged on resolver/ECS/geo/ASN metadata; a different query
 *    context could differ.
 *  - probabilistic: a shuffle / weighted-shuffle / shed-load probability is involved — the specific
 *    returned answer is NOT fixed; only a likelihood is known.
 *  - partial: at least one filter is unsupported locally; evaluation cannot claim certainty. */
export type SelectionDeterminism = 'deterministic' | 'context_dependent' | 'probabilistic' | 'partial';

/** One filter's execution trace. Field names follow the NS1 Developer Guide §8.1;
 *  every input answer is accounted for by exactly one outcome. */
export interface FilterTrace {
  index: number;
  type: string;
  disabled: boolean;
  supported: boolean;
  behaviour: FilterBehaviour;
  config: Record<string, unknown>;
  metadataConsumed: string[];
  input: string[]; // answer ids entering, in order
  output: string[]; // answer ids leaving, in order
  orderingBefore: string[]; // = input order
  orderingAfter: string[]; // = output order
  removedAnswerIds: string[]; // answers eliminated by this step (input − output)
  outcomes: AnswerOutcome[];
  reorder: boolean;
  reason: string;
  confidence: import('./identity.js').Confidence;
  warning?: string;
}

export interface ExpectedShare {
  answerId: string;
  label: string;
  deliveryPlatform?: string;
  share: number; // 0..1
}

export interface ExpectedDistribution {
  probabilistic: true;
  method: 'weighted_shuffle' | 'uniform_shuffle' | 'single_answer';
  shares: ExpectedShare[];
  disclaimers: string[];
}

/** The complete, explainable evaluation output. Field names follow the NS1
 *  Developer Guide §25 (`traces`, `eligibleAnswerIds`, `complete`,
 *  `stoppedAtFilterIndex`, `explanation`); `expectedDistribution` is RADAR's richer,
 *  explicitly-probabilistic form of the guide's minimal share map. `scenario`,
 *  `answers`, `selected` and `unsupportedFilters` are additive RADAR conveniences. */
export interface EvaluationResult {
  scenario: Scenario;
  identity: DerivedIdentity;
  answers: TracedAnswer[];
  traces: FilterTrace[];
  eligibleAnswerIds: string[];
  /** The single surviving answer after the chain, when exactly one remains. NOTE: this is only a
   *  DEFINITIVE selection when `selectionDeterminism === 'deterministic'`; otherwise it is the
   *  most-likely answer for display and must be worded as such (never "active"). */
  selected?: string;
  /** How reliable the final selection is; governs how the UI must word `selected`. */
  selectionDeterminism: SelectionDeterminism;
  expectedDistribution?: ExpectedDistribution;
  complete: boolean;
  stoppedAtFilterIndex?: number;
  explanation: string;
  warnings: string[];
  unsupportedFilters: string[];
  /** Steering metadata keys present on the record's answers (excludes descriptive `note`). */
  metadataConfigured: string[];
  /** Metadata keys actually read by a supported, enabled filter in this chain. Keys in
   *  `metadataConfigured` but not here are configured-but-unused — they have no steering effect
   *  in the current chain (spec §7). */
  metadataConsumed: string[];
}

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
}

/** How a filter acts on the answer list (NS1 guide §8.1). */
export type FilterBehaviour = 'eliminate' | 'reorder' | 'select' | 'group' | 'modify' | 'unknown';

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
  selected?: string;
  expectedDistribution?: ExpectedDistribution;
  complete: boolean;
  stoppedAtFilterIndex?: number;
  explanation: string;
  warnings: string[];
  unsupportedFilters: string[];
}

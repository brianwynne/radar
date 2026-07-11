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

export interface FilterStepTrace {
  index: number;
  type: string;
  disabled: boolean;
  supported: boolean;
  config: Record<string, unknown>;
  metadataConsumed: string[];
  input: string[]; // answer ids entering, in order
  output: string[]; // answer ids leaving, in order
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

/** The complete, explainable evaluation output (brief §9). */
export interface EvaluationResult {
  scenario: Scenario;
  identity: DerivedIdentity;
  answers: TracedAnswer[];
  steps: FilterStepTrace[];
  survivors: string[];
  selected?: string;
  expectedDistribution?: ExpectedDistribution;
  certain: boolean;
  warnings: string[];
  unsupportedFilters: string[];
}

// Predicted-vs-observed comparison and confidence classification — the analytical core.
// Deliberately conservative: a single observation is never treated as proof of the
// probabilistic distribution; answer-order differences are NOT a mismatch when the record
// orders probabilistically; a low-confidence observation is never asserted as a match.
import type {
  ComparisonDifference, ComparisonResult, DnsObservationScenario, ObservationConfidence,
  ObservationChangeReason, PredictedSteering, RawObservation,
} from './types.js';

/** Confidence that an observation represents the ISP's subscribers. */
export function classifyConfidence(scenario: DnsObservationScenario, obs: RawObservation): ObservationConfidence {
  if (obs.disabled || obs.responseCode === 'TIMEOUT' || obs.responseCode === 'NETWORK_ERROR') return 'unknown';
  if (obs.responseCode !== 'NOERROR') return 'unknown'; // an error response is not representative evidence
  // ECS honoured with an approved, customer-representative subnet on a representative ISP.
  if (obs.ecsRequested && obs.ecsHonoured && scenario.ecsSubnet && scenario.expectedRepresentativeness === 'high') return 'high';
  // Direct ISP resolver considered representative (with or without honoured ECS).
  if (scenario.expectedRepresentativeness === 'high' || scenario.expectedRepresentativeness === 'medium') return 'medium';
  return 'low'; // public/shared resolver or uncertain location
}

const UNAVAILABLE = new Set(['TIMEOUT', 'NETWORK_ERROR', 'SERVFAIL', 'REFUSED', 'FORMERR', 'OTHER']);

function orderDiffers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

export function compareObservation(predicted: PredictedSteering, obs: RawObservation, scenario: DnsObservationScenario): ComparisonResult {
  const confidence = classifyConfidence(scenario, obs);
  const differences: ComparisonDifference[] = [];

  // No usable observation → unavailable (never invents a comparison).
  if (obs.disabled) {
    return { comparisonStatus: 'observation_unavailable', matchStatus: 'unknown', confidence: 'unknown', differences: [{ kind: 'no_response', detail: 'DNS observation is disabled.' }], explanation: 'DNS observation is disabled; no observed answer.' };
  }
  if (obs.responseCode === 'TIMEOUT' || obs.responseCode === 'NETWORK_ERROR') {
    return { comparisonStatus: 'observation_unavailable', matchStatus: 'unknown', confidence, differences: [{ kind: 'no_response', detail: `Resolver did not respond (${obs.responseCode}).` }], explanation: 'No response from the resolver; comparison unavailable.' };
  }
  if (UNAVAILABLE.has(obs.responseCode)) {
    return { comparisonStatus: 'observation_unavailable', matchStatus: 'unknown', confidence, differences: [{ kind: 'dns_error_response', detail: `Resolver returned ${obs.responseCode}.` }], explanation: `Resolver returned ${obs.responseCode}; comparison unavailable.` };
  }

  const observedIps = obs.answers.map((a) => a.address);
  const predictedSet = new Set(predicted.answerIps);
  const observedSet = new Set(observedIps);

  // Contextual (non-terminal) differences.
  if (obs.ecsRequested && !obs.ecsHonoured) differences.push({ kind: 'ecs_discrepancy', detail: 'ECS was requested but the response did not confirm it was honoured.' });
  if (!obs.ecsRequested || !obs.ecsHonoured) differences.push({ kind: 'resolver_only_observation', detail: 'Observation reflects the resolver, not a confirmed customer-representative ECS scope.' });
  if (!predicted.complete) differences.push({ kind: 'partial_radar_evaluation', detail: 'RADAR could not fully evaluate the record; prediction is partial.' });
  if (predicted.unsupportedFilters.length > 0) differences.push({ kind: 'unsupported_record_filter', detail: `Unsupported filter(s): ${predicted.unsupportedFilters.join(', ')}.` });
  if (predicted.ttl !== undefined && obs.ttl !== undefined && predicted.ttl !== obs.ttl) differences.push({ kind: 'ttl_difference', detail: `Predicted TTL ${predicted.ttl}s vs observed ${obs.ttl}s.` });

  if (obs.responseCode === 'NXDOMAIN') {
    differences.push({ kind: 'dns_error_response', detail: 'Resolver returned NXDOMAIN; the authoritative reports no such record.' });
    return finalise('mismatch', confidence, differences, 'Observed NXDOMAIN where RADAR predicted answers.');
  }

  const unexpected = observedIps.filter((ip) => !predictedSet.has(ip));
  const missing = predicted.answerIps.filter((ip) => !observedSet.has(ip));
  const probabilistic = predicted.method === 'weighted_shuffle' || predicted.method === 'uniform_shuffle';

  let setStatus: ComparisonResult['matchStatus'];
  if (observedIps.length === 0) {
    differences.push({ kind: 'missing_predicted_answer', detail: 'Response contained no A/AAAA answers.' });
    setStatus = 'mismatch';
  } else if (unexpected.length > 0) {
    differences.push({ kind: 'unexpected_observed_answer', detail: `Observed answer(s) not in the predicted eligible set: ${unexpected.join(', ')}.` });
    setStatus = 'mismatch';
  } else if (predicted.expectsSubsetSelection) {
    // Observed is a valid sample of the eligible set (e.g. select_first_n) — a match, and a
    // single sample is NOT compared against the theoretical distribution.
    setStatus = 'match';
  } else if (missing.length > 0) {
    differences.push({ kind: 'missing_predicted_answer', detail: `Predicted answer(s) absent from the response: ${missing.join(', ')}.` });
    setStatus = 'partial_match';
  } else {
    setStatus = 'match';
    if (!probabilistic && orderDiffers(observedIps, predicted.answerIps)) {
      differences.push({ kind: 'same_set_different_order', detail: 'Same answer set in a different order (record is not probabilistically ordered).' });
    }
  }

  // A partial RADAR evaluation can never be asserted as a clean match.
  if (!predicted.complete && setStatus === 'match') setStatus = 'partial_match';

  return finalise(setStatus, confidence, differences, explain(setStatus, probabilistic, predicted));
}

function explain(setStatus: ComparisonResult['matchStatus'], probabilistic: boolean, predicted: PredictedSteering): string {
  const base =
    setStatus === 'match'
      ? 'Observed answers are consistent with RADAR’s predicted eligible set.'
      : setStatus === 'partial_match'
        ? 'Observed answers are within the predicted set but not identical.'
        : 'Observed answers diverge from RADAR’s prediction.';
  const sampleNote = probabilistic || predicted.expectsSubsetSelection ? ' A single observation is one sample and does not verify the expected distribution.' : '';
  return base + sampleNote;
}

/** Apply the confidence override: a low/unknown-confidence observation is reported as
 *  `confidence_low` rather than asserting match/mismatch. */
function finalise(matchStatus: ComparisonResult['matchStatus'], confidence: ObservationConfidence, differences: ComparisonDifference[], explanation: string): ComparisonResult {
  const comparisonStatus = confidence === 'low' || confidence === 'unknown' ? 'confidence_low' : matchStatus;
  const suffix = comparisonStatus === 'confidence_low' ? ' Confidence is low, so this comparison is not asserted as authoritative.' : '';
  return { comparisonStatus, matchStatus, confidence, differences, explanation: explanation + suffix };
}

// --- Observation-change reason (drives the observed-DNS highlight) -----------

interface ObservationSnapshot {
  comparisonStatus: string;
  confidence: string;
  resolverIp?: string;
  ecsHonoured?: boolean;
  ttl?: number;
  responseCode?: string;
  answerAddresses: string[];
}

const AVAILABLE = (s: string) => s !== 'observation_unavailable';

/** Classify what changed between two consecutive observations. Never claims traffic changed. */
export function classifyObservationChange(prev: ObservationSnapshot, curr: ObservationSnapshot): ObservationChangeReason {
  if (AVAILABLE(prev.comparisonStatus) && !AVAILABLE(curr.comparisonStatus)) return 'observation_became_unavailable';
  if (!AVAILABLE(prev.comparisonStatus) && AVAILABLE(curr.comparisonStatus)) return 'observation_recovered';
  if (prev.answerAddresses.slice().sort().join(',') !== curr.answerAddresses.slice().sort().join(',')) return 'observed_answer_set_changed';
  if (prev.comparisonStatus !== curr.comparisonStatus) return 'predicted_observed_match_changed';
  if ((prev.ecsHonoured ?? null) !== (curr.ecsHonoured ?? null)) return 'ecs_behaviour_changed';
  if ((prev.resolverIp ?? '') !== (curr.resolverIp ?? '')) return 'resolver_changed';
  if ((prev.ttl ?? null) !== (curr.ttl ?? null)) return 'ttl_changed';
  if (prev.confidence !== curr.confidence) return 'confidence_changed';
  return 'unknown_change';
}

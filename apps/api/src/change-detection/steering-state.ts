// Steering-state fingerprinting and change-reason classification. The fingerprint is
// STABLE: it excludes timestamps, correlation ids and the random Weighted-Shuffle ordering,
// so it changes only on a meaningful steering difference. Reasons are attributed by a
// deterministic priority; when nothing is clearly attributable, `unknown_structural_change`
// (displayed as "Reason not yet attributable") is used rather than inventing causality.
import type { EvaluationResult } from '@radar/engine';
import type { NewSteeringState, SteeringState } from '@radar/data';
import { sha256 } from '../ns1/snapshot.js';
import { preferredPathForAsn } from './isps.js';
import type { IspScenario } from './types.js';

export const STEERING_REASONS = [
  'answer_became_unavailable',
  'answer_became_eligible',
  'asn_match_changed',
  'prefix_match_changed',
  'country_match_changed',
  'expected_weight_changed',
  'filter_chain_changed',
  'evaluation_became_partial',
  'evaluation_became_complete',
  'preferred_path_changed',
  'record_checksum_changed',
  'unknown_structural_change',
] as const;
export type SteeringReason = (typeof STEERING_REASONS)[number];

export const REASON_DISPLAY: Record<SteeringReason, string> = {
  answer_became_unavailable: 'A delivery platform became unavailable',
  answer_became_eligible: 'A delivery platform became eligible',
  asn_match_changed: 'ASN match changed',
  prefix_match_changed: 'Prefix match changed',
  country_match_changed: 'Country match changed',
  expected_weight_changed: 'Expected distribution changed',
  filter_chain_changed: 'Filter chain changed',
  evaluation_became_partial: 'Evaluation became partial',
  evaluation_became_complete: 'Evaluation became complete',
  preferred_path_changed: 'Preferred network path changed',
  record_checksum_changed: 'Record configuration changed',
  unknown_structural_change: 'Reason not yet attributable',
};

const distKey = (d: { answerId: string; share: number }[]): string =>
  [...d].map((s) => `${s.answerId}:${s.share.toFixed(3)}`).sort().join('|');

/** Stable fingerprint. Weighted-Shuffle ordering, timestamps and correlation ids are
 *  excluded; eligibility and expected shares (deterministic from weights) are included. */
export function steeringFingerprint(s: {
  eligibleAnswerIds: string[];
  distribution: { answerId: string; share: number }[];
  complete: boolean;
  stoppedAtFilterIndex?: number;
  identitySource?: string;
  country?: string;
  asn?: number;
  matchedPrefix?: string;
  preferredPath: string;
  structuralChecksum?: string;
}): string {
  return sha256(
    [
      [...s.eligibleAnswerIds].sort().join(','),
      distKey(s.distribution),
      s.complete,
      s.stoppedAtFilterIndex ?? '',
      s.identitySource ?? '',
      s.country ?? '',
      s.asn ?? '',
      s.matchedPrefix ?? '',
      s.preferredPath,
      s.structuralChecksum ?? '',
    ].join('||'),
  );
}

export function buildSteeringState(ev: EvaluationResult, isp: IspScenario, resourceKey: string, recordChecksum: string, now: Date): NewSteeringState {
  const distribution = (ev.expectedDistribution?.shares ?? []).map((s) => ({ answerId: s.answerId, label: s.label, deliveryPlatform: s.deliveryPlatform, share: s.share }));
  const preferredPath = preferredPathForAsn(isp.asn);
  const fingerprint = steeringFingerprint({
    eligibleAnswerIds: ev.eligibleAnswerIds,
    distribution,
    complete: ev.complete,
    stoppedAtFilterIndex: ev.stoppedAtFilterIndex,
    identitySource: ev.identity.source,
    country: ev.identity.country,
    asn: ev.identity.asn,
    matchedPrefix: ev.identity.prefix,
    preferredPath,
    structuralChecksum: recordChecksum,
  });
  return {
    ispId: isp.id,
    resourceKey,
    ispName: isp.name,
    asn: isp.asn,
    fingerprint,
    identitySource: ev.identity.source,
    country: ev.identity.country,
    matchedPrefix: ev.identity.prefix,
    preferredPath,
    eligibleAnswerIds: ev.eligibleAnswerIds,
    distribution,
    filterChain: ev.traces.map((t) => t.type),
    complete: ev.complete,
    stoppedAtFilterIndex: ev.stoppedAtFilterIndex,
    structuralChecksum: recordChecksum,
    evaluatedAt: now,
  };
}

type StateLike = Pick<SteeringState, 'eligibleAnswerIds' | 'complete' | 'filterChain' | 'matchedPrefix' | 'country' | 'asn' | 'preferredPath' | 'distribution' | 'structuralChecksum'>;

export function classifyReason(prev: StateLike, curr: StateLike): SteeringReason {
  const prevEligible = new Set(prev.eligibleAnswerIds);
  const currEligible = new Set(curr.eligibleAnswerIds);
  if ([...prevEligible].some((id) => !currEligible.has(id))) return 'answer_became_unavailable';
  if ([...currEligible].some((id) => !prevEligible.has(id))) return 'answer_became_eligible';
  if (prev.complete && !curr.complete) return 'evaluation_became_partial';
  if (!prev.complete && curr.complete) return 'evaluation_became_complete';
  if (prev.filterChain.join(',') !== curr.filterChain.join(',')) return 'filter_chain_changed';
  if ((prev.matchedPrefix ?? '') !== (curr.matchedPrefix ?? '')) return 'prefix_match_changed';
  if ((prev.country ?? '') !== (curr.country ?? '')) return 'country_match_changed';
  if ((prev.asn ?? '') !== (curr.asn ?? '')) return 'asn_match_changed';
  if ((prev.preferredPath ?? '') !== (curr.preferredPath ?? '')) return 'preferred_path_changed';
  if (distKey(prev.distribution) !== distKey(curr.distribution)) return 'expected_weight_changed';
  if ((prev.structuralChecksum ?? '') !== (curr.structuralChecksum ?? '')) return 'record_checksum_changed';
  return 'unknown_structural_change';
}

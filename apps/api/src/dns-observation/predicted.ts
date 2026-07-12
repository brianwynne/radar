// Build RADAR's PredictedSteering for an ISP scenario from the current NS1 record, using the
// existing engine. The predicted "eligible pool" is the set of answers NS1 might return for
// this identity (the expected-distribution shares); a terminal selection (select_first_n /
// single answer) means the observed answer is a valid SAMPLE of that pool, not the whole set.
import { evaluate, type NS1Record, type Scenario } from '@radar/engine';
import { structuralChecksum } from '../ns1/snapshot.js';
import type { DnsObservationScenario, PredictedAnswer, PredictedSteering } from './types.js';

export function buildPredictedSteering(raw: unknown, record: NS1Record, scenario: DnsObservationScenario): PredictedSteering {
  const evalScenario: Scenario = {
    qname: scenario.domain, qtype: scenario.recordType, resolverIp: '9.9.9.9',
    ecsPresent: true, ecsPrefix: scenario.ecsSubnet, country: scenario.country, asn: scenario.asn,
  };
  const ev = evaluate(record, evalScenario);
  const byId = new Map(ev.answers.map((a) => [a.id, a] as const));
  const shares = ev.expectedDistribution?.shares ?? [];

  // Pool answer ids = distribution shares when present (every answer with selection
  // probability), else the eligible set.
  const poolIds = shares.length > 0 ? shares.map((s) => s.answerId) : ev.eligibleAnswerIds;
  const answers: PredictedAnswer[] = poolIds.map((id) => {
    const a = byId.get(id);
    return { answerId: id, addresses: a?.rdata ?? [], deliveryPlatform: a?.deliveryPlatform };
  });
  const answerIps = answers.flatMap((a) => a.addresses);

  const expectsSubsetSelection =
    ev.expectedDistribution?.method === 'single_answer' ||
    ev.selected !== undefined ||
    ev.traces.some((t) => t.supported && t.type.toLowerCase().includes('select_first'));

  const rawTtl = raw && typeof raw === 'object' && typeof (raw as { ttl?: unknown }).ttl === 'number' ? (raw as { ttl: number }).ttl : undefined;

  return {
    answers,
    answerIps,
    distribution: shares.map((s) => ({ answerId: s.answerId, label: s.label, deliveryPlatform: s.deliveryPlatform, share: s.share })),
    complete: ev.complete,
    method: ev.expectedDistribution?.method,
    unsupportedFilters: ev.unsupportedFilters,
    expectsSubsetSelection,
    ttl: rawTtl,
    recordChecksum: structuralChecksum(raw),
  };
}

import { describe, it, expect } from 'vitest';
import { evaluate, type NS1Record, type Scenario } from '@radar/engine';
import { steeringFingerprint, classifyReason, buildSteeringState, REASON_DISPLAY, STEERING_REASONS } from '../src/change-detection/steering-state.js';
import { ISP_SCENARIOS } from '../src/change-detection/isps.js';
import type { SteeringState } from '@radar/data';

const base = {
  eligibleAnswerIds: ['a', 'b'],
  distribution: [
    { answerId: 'a', share: 0.7 },
    { answerId: 'b', share: 0.3 },
  ],
  complete: true,
  identitySource: 'ecs',
  country: 'IE',
  asn: 5466,
  matchedPrefix: '185.2.100.0/24',
  preferredPath: 'Eir PNI',
  structuralChecksum: 'sha256:aaaa',
};

describe('steeringFingerprint', () => {
  it('is stable across eligible-id and distribution ORDER (excludes Weighted-Shuffle ordering)', () => {
    const a = steeringFingerprint(base);
    const reordered = steeringFingerprint({
      ...base,
      eligibleAnswerIds: ['b', 'a'],
      distribution: [
        { answerId: 'b', share: 0.3 },
        { answerId: 'a', share: 0.7 },
      ],
    });
    expect(reordered).toBe(a);
  });

  it('does not depend on timestamps or correlation ids (they are not inputs)', () => {
    // The function has no time input; identical structural inputs → identical fingerprint.
    expect(steeringFingerprint(base)).toBe(steeringFingerprint({ ...base }));
  });

  it('changes when a meaningful field changes', () => {
    const a = steeringFingerprint(base);
    expect(steeringFingerprint({ ...base, eligibleAnswerIds: ['a'] })).not.toBe(a); // eligibility
    expect(steeringFingerprint({ ...base, distribution: [{ answerId: 'a', share: 0.6 }, { answerId: 'b', share: 0.4 }] })).not.toBe(a); // weights
    expect(steeringFingerprint({ ...base, complete: false })).not.toBe(a); // completeness
    expect(steeringFingerprint({ ...base, preferredPath: 'Transit' })).not.toBe(a); // path
    expect(steeringFingerprint({ ...base, structuralChecksum: 'sha256:bbbb' })).not.toBe(a); // record checksum
  });
});

const state = (over: Partial<SteeringState>): SteeringState => ({
  ispId: 'eir', resourceKey: 'r', ispName: 'Eir', asn: 5466, fingerprint: 'fp',
  identitySource: 'ecs', country: 'IE', matchedPrefix: '185.2.100.0/24', preferredPath: 'Eir PNI',
  eligibleAnswerIds: ['a', 'b'], distribution: [{ answerId: 'a', label: 'A', share: 0.7 }, { answerId: 'b', label: 'B', share: 0.3 }],
  filterChain: ['up', 'weighted_shuffle'], complete: true, structuralChecksum: 'sha256:aaaa',
  evaluatedAt: new Date('2026-07-11T10:00:00Z'), updatedAt: new Date('2026-07-11T10:00:00Z'), ...over,
});

describe('classifyReason', () => {
  it('attributes an unavailable answer', () => {
    expect(classifyReason(state({}), state({ eligibleAnswerIds: ['b'] }))).toBe('answer_became_unavailable');
  });
  it('attributes a newly eligible answer', () => {
    expect(classifyReason(state({ eligibleAnswerIds: ['b'] }), state({}))).toBe('answer_became_eligible');
  });
  it('attributes completeness transitions', () => {
    expect(classifyReason(state({}), state({ complete: false }))).toBe('evaluation_became_partial');
    expect(classifyReason(state({ complete: false }), state({}))).toBe('evaluation_became_complete');
  });
  it('attributes filter-chain, prefix, country, asn and path changes', () => {
    expect(classifyReason(state({}), state({ filterChain: ['up'] }))).toBe('filter_chain_changed');
    expect(classifyReason(state({}), state({ matchedPrefix: '10.0.0.0/24' }))).toBe('prefix_match_changed');
    expect(classifyReason(state({}), state({ country: 'GB' }))).toBe('country_match_changed');
    expect(classifyReason(state({}), state({ asn: 6830 }))).toBe('asn_match_changed');
    expect(classifyReason(state({}), state({ preferredPath: 'Transit' }))).toBe('preferred_path_changed');
  });
  it('attributes a distribution weight change', () => {
    expect(classifyReason(state({}), state({ distribution: [{ answerId: 'a', label: 'A', share: 0.6 }, { answerId: 'b', label: 'B', share: 0.4 }] }))).toBe('expected_weight_changed');
  });
  it('falls back to an unattributed structural change (never invents causality)', () => {
    // structuralChecksum differs but nothing else RADAR can name.
    expect(classifyReason(state({}), state({ structuralChecksum: 'sha256:zzzz' }))).toBe('record_checksum_changed');
    expect(REASON_DISPLAY.unknown_structural_change).toBe('Reason not yet attributable');
  });
  it('every reason has a display label', () => {
    for (const r of STEERING_REASONS) expect(typeof REASON_DISPLAY[r]).toBe('string');
  });
});

const RECORD: NS1Record = {
  domain: 'live.rte.ie',
  type: 'A',
  use_client_subnet: true,
  answers: [
    { id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: true, weight: 70 } },
    { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, weight: 30 } },
  ],
  filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }],
} as unknown as NS1Record;

describe('buildSteeringState', () => {
  it('builds a NewSteeringState with a fingerprint, eligible ids, distribution and derived path', () => {
    const isp = ISP_SCENARIOS[0]; // Eir
    const scenario: Scenario = { qname: 'live.rte.ie', qtype: 'A', resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: isp.ecsPrefix, country: 'IE', asn: isp.asn };
    const ev = evaluate(RECORD, scenario);
    const s = buildSteeringState(ev, isp, 'rte.ie/live.rte.ie/A', 'sha256:cccc', new Date('2026-07-11T10:00:00Z'));
    expect(s.ispId).toBe('eir');
    expect(s.preferredPath).toBe('Eir PNI');
    expect(s.structuralChecksum).toBe('sha256:cccc');
    expect(s.fingerprint).toMatch(/^sha256:/);
    expect(s.eligibleAnswerIds).toEqual(ev.eligibleAnswerIds);
    expect(s.filterChain).toEqual(['up', 'weighted_shuffle']);
    expect('updatedAt' in s).toBe(false); // NewSteeringState omits updatedAt
  });
});

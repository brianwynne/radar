import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluate, type NS1Record, type Scenario } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(readFileSync(join(here, 'fixtures/live.rte.ie.json'), 'utf8')) as NS1Record;

const irishEcs: Scenario = {
  record: 'live.rte.ie A',
  resolverIp: '9.9.9.9',
  ecsPresent: true,
  ecsPrefix: '185.2.100.0/24',
  country: 'IE',
  asn: 5466,
};

const germanEcs: Scenario = {
  record: 'live.rte.ie A',
  resolverIp: '9.9.9.9',
  ecsPresent: true,
  ecsPrefix: '91.0.0.0/24',
  country: 'DE',
  asn: 3320,
};

describe('identity derivation (RADAR §8)', () => {
  it('uses ECS when present and honoured, with high confidence', () => {
    const r = evaluate(record, irishEcs);
    expect(r.identity.sourceUsed).toBe('ecs');
    expect(r.identity.evaluatedAddress).toBe('185.2.100.0/24');
    expect(r.identity.confidence).toBe('high');
  });

  it('falls back to resolver IP and flags it when ECS is absent', () => {
    const r = evaluate(record, { ...irishEcs, ecsPresent: false, ecsPrefix: undefined });
    expect(r.identity.sourceUsed).toBe('resolver');
    expect(r.identity.notes.join(' ')).toMatch(/resolver/i);
  });

  it('ignores ECS when the record disables use_client_subnet', () => {
    const r = evaluate({ ...record, use_client_subnet: false }, irishEcs);
    expect(r.identity.sourceUsed).toBe('resolver');
    expect(r.identity.notes.join(' ')).toMatch(/use_client_subnet=false/);
  });
});

describe('filter chain — every answer accounted for at every step (RADAR §5.2)', () => {
  it('accounts for exactly the input answers in each step, once each', () => {
    const r = evaluate(record, irishEcs);
    for (const step of r.steps) {
      expect(step.outcomes.map((o) => o.answerId).sort()).toEqual([...step.input].sort());
    }
  });

  it('preserves exact configured filter order', () => {
    const r = evaluate(record, irishEcs);
    expect(r.steps.map((s) => s.type)).toEqual([
      'up', 'geotarget_country', 'netfence_asn', 'priority', 'weighted_shuffle', 'select_first_n',
    ]);
  });
});

describe('Irish ASN (on-net) scenario', () => {
  const r = evaluate(record, irishEcs);

  it('keeps Réalta eligible and puts CloudFront standby on the priority tier', () => {
    const priorityStep = r.steps.find((s) => s.type === 'priority')!;
    expect(priorityStep.output).toContain('ans-realta');
    expect(priorityStep.outcomes.find((o) => o.answerId === 'ans-cloudfront')!.disposition).toBe('standby');
  });

  it('selects one delivery platform and reports the probabilistic 70/20/10 distribution', () => {
    expect(r.selected).toBeDefined();
    const shares = Object.fromEntries(r.expectedDistribution!.shares.map((s) => [s.deliveryPlatform, s.share]));
    expect(shares['Réalta']).toBeCloseTo(0.7, 5);
    expect(shares['Fastly']).toBeCloseTo(0.2, 5);
    expect(shares['Akamai']).toBeCloseTo(0.1, 5);
    expect(r.expectedDistribution!.probabilistic).toBe(true);
  });
});

describe('off-net (German) scenario — ASN fencing removes Réalta', () => {
  const r = evaluate(record, germanEcs);

  it('removes Réalta at netfence_asn and redistributes across Fastly/Akamai', () => {
    const asnStep = r.steps.find((s) => s.type === 'netfence_asn')!;
    expect(asnStep.outcomes.find((o) => o.answerId === 'ans-realta')!.disposition).toBe('removed');
    const shares = Object.fromEntries(r.expectedDistribution!.shares.map((s) => [s.deliveryPlatform, s.share]));
    expect(shares['Réalta']).toBeUndefined();
    expect(shares['Fastly']).toBeCloseTo(2 / 3, 5);
    expect(shares['Akamai']).toBeCloseTo(1 / 3, 5);
  });
});

describe('health override', () => {
  it('removes an answer marked down at the up filter', () => {
    const r = evaluate(record, { ...irishEcs, healthOverrides: { 'ans-realta': false } });
    const upStep = r.steps.find((s) => s.type === 'up')!;
    expect(upStep.outcomes.find((o) => o.answerId === 'ans-realta')!.disposition).toBe('removed');
    expect(r.survivors).not.toContain('ans-realta');
  });
});

describe('unsupported filter (RADAR §5.4) — partial evaluation, no false certainty', () => {
  it('flags unsupported filters, sets certain=false, and passes answers through', () => {
    const withUnsupported: NS1Record = {
      ...record,
      filters: [{ filter: 'up' }, { filter: 'shed_load' }, { filter: 'select_first_n', config: { N: 1 } }],
    };
    const r = evaluate(withUnsupported, irishEcs);
    expect(r.certain).toBe(false);
    expect(r.unsupportedFilters).toContain('shed_load');
    const step = r.steps.find((s) => s.type === 'shed_load')!;
    expect(step.supported).toBe(false);
    expect(step.input).toEqual(step.output); // pass-through, nothing dropped silently
    expect(r.warnings.join(' ')).toMatch(/partial/i);
  });
});

describe('NS1 vs Cloudflare separation (RADAR §7)', () => {
  it('never attributes individual cache/pool selection to NS1 in the distribution disclaimers', () => {
    const r = evaluate(record, irishEcs);
    expect(r.expectedDistribution!.disclaimers.join(' ')).toMatch(/Cloudflare pool/i);
  });
});

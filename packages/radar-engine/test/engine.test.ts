import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluate, type NS1Record, type Scenario } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(readFileSync(join(here, 'fixtures/live.rte.ie.json'), 'utf8')) as NS1Record;

const irishEcs: Scenario = {
  qname: 'live.rte.ie',
  qtype: 'A',
  resolverIp: '9.9.9.9',
  ecsPresent: true,
  ecsPrefix: '185.2.100.0/24',
  country: 'IE',
  asn: 5466,
};

const germanEcs: Scenario = {
  qname: 'live.rte.ie',
  qtype: 'A',
  resolverIp: '9.9.9.9',
  ecsPresent: true,
  ecsPrefix: '91.0.0.0/24',
  country: 'DE',
  asn: 3320,
};

const share = (r: ReturnType<typeof evaluate>, platform: string): number | undefined =>
  r.expectedDistribution?.shares.find((s) => s.deliveryPlatform === platform)?.share;

describe('identity derivation (guide §9)', () => {
  it('uses ECS when present and honoured, with high confidence', () => {
    const r = evaluate(record, irishEcs);
    expect(r.identity.source).toBe('ecs');
    expect(r.identity.evaluatedAddress).toBe('185.2.100.0/24');
    expect(r.identity.confidence).toBe('high');
  });

  it('falls back to resolver IP and flags it when ECS is absent', () => {
    const r = evaluate(record, { ...irishEcs, ecsPresent: false, ecsPrefix: undefined });
    expect(r.identity.source).toBe('resolver');
    expect(r.identity.notes.join(' ')).toMatch(/resolver/i);
  });

  it('ignores ECS when the record disables use_client_subnet', () => {
    const r = evaluate({ ...record, use_client_subnet: false }, irishEcs);
    expect(r.identity.source).toBe('resolver');
    expect(r.identity.notes.join(' ')).toMatch(/use_client_subnet=false/);
  });
});

describe('trace contract (guide §8.1)', () => {
  const r = evaluate(record, irishEcs);

  it('preserves exact configured filter order', () => {
    expect(r.traces.map((t) => t.type)).toEqual([
      'up', 'geotarget_country', 'netfence_asn', 'weighted_shuffle', 'select_first_n',
    ]);
  });

  it('accounts for exactly the input answers in each trace, once each', () => {
    for (const t of r.traces) {
      expect(t.outcomes.map((o) => o.answerId).sort()).toEqual([...t.input].sort());
    }
  });

  it('exposes behaviour, ordering and removedAnswerIds per trace', () => {
    const asn = r.traces.find((t) => t.type === 'netfence_asn')!;
    expect(asn.behaviour).toBe('eliminate');
    expect(asn.orderingBefore).toEqual(asn.input);
    expect(asn.orderingAfter).toEqual(asn.output);
    expect(asn.removedAnswerIds).toEqual(asn.input.filter((id) => !asn.output.includes(id)));
    expect(r.traces.find((t) => t.type === 'weighted_shuffle')!.behaviour).toBe('reorder');
    expect(r.traces.find((t) => t.type === 'select_first_n')!.behaviour).toBe('select');
  });
});

describe('Irish ASN (on-net) scenario', () => {
  const r = evaluate(record, irishEcs);

  it('completes, selects one platform, and reports the probabilistic 70/20/10 distribution', () => {
    expect(r.complete).toBe(true);
    expect(r.stoppedAtFilterIndex).toBeUndefined();
    expect(r.selected).toBe('ans-realta');
    expect(share(r, 'Réalta')).toBeCloseTo(0.7, 5);
    expect(share(r, 'Fastly')).toBeCloseTo(0.2, 5);
    expect(share(r, 'Akamai')).toBeCloseTo(0.1, 5);
    expect(r.expectedDistribution!.probabilistic).toBe(true);
  });

  it('keeps CloudFront as a zero-share standby (weight 0)', () => {
    expect(share(r, 'CloudFront standby')).toBe(0);
  });

  it('produces a human-readable explanation naming the selected platform', () => {
    expect(r.explanation).toMatch(/Réalta/);
    expect(r.explanation).toMatch(/live\.rte\.ie A/);
    expect(r.explanation.length).toBeGreaterThan(20);
  });
});

describe('off-net (German) scenario — ASN fencing removes Réalta', () => {
  const r = evaluate(record, germanEcs);

  it('removes Réalta at netfence_asn (recorded in removedAnswerIds) and redistributes', () => {
    const asn = r.traces.find((t) => t.type === 'netfence_asn')!;
    expect(asn.removedAnswerIds).toContain('ans-realta');
    expect(share(r, 'Réalta')).toBeUndefined();
    expect(share(r, 'Fastly')).toBeCloseTo(2 / 3, 5);
    expect(share(r, 'Akamai')).toBeCloseTo(1 / 3, 5);
  });
});

describe('health override', () => {
  it('removes an answer marked down at the up filter', () => {
    const r = evaluate(record, { ...irishEcs, healthOverrides: { 'ans-realta': false } });
    const upStep = r.traces.find((t) => t.type === 'up')!;
    expect(upStep.removedAnswerIds).toContain('ans-realta');
    expect(r.eligibleAnswerIds).not.toContain('ans-realta');
  });
});

describe('unsupported filter (guide §17, principle 5.4) — partial evaluation', () => {
  it('flags an unrecognised filter, sets complete=false + stoppedAtFilterIndex, passes answers through', () => {
    const withUnsupported: NS1Record = {
      ...record,
      filters: [{ filter: 'up' }, { filter: 'shed_load' }, { filter: 'select_first_n', config: { N: 1 } }],
    };
    const r = evaluate(withUnsupported, irishEcs);
    expect(r.complete).toBe(false);
    expect(r.stoppedAtFilterIndex).toBe(1);
    expect(r.unsupportedFilters).toContain('shed_load');
    const t = r.traces.find((s) => s.type === 'shed_load')!;
    expect(t.supported).toBe(false);
    expect(t.behaviour).toBe('unknown');
    expect(t.input).toEqual(t.output); // nothing dropped silently
    expect(r.explanation).toMatch(/INCOMPLETE/);
  });

  it('treats priority as unsupported until a fixture confirms it, while preserving its raw config', () => {
    const withPriority: NS1Record = {
      ...record,
      filters: [{ filter: 'up' }, { filter: 'priority', config: { some_wire_field: true } }, { filter: 'select_first_n', config: { N: 1 } }],
    };
    const r = evaluate(withPriority, irishEcs);
    expect(r.complete).toBe(false);
    expect(r.stoppedAtFilterIndex).toBe(1);
    expect(r.unsupportedFilters).toContain('priority');
    const t = r.traces.find((s) => s.type === 'priority')!;
    expect(t.supported).toBe(false);
    expect(t.config).toEqual({ some_wire_field: true }); // raw config still displayed
  });
});

describe('NS1 vs Cloudflare separation (guide §2, RADAR §7)', () => {
  it('disclaims Cloudflare pool selection in the distribution', () => {
    const r = evaluate(record, irishEcs);
    expect(r.expectedDistribution!.disclaimers.join(' ')).toMatch(/Cloudflare pool/i);
  });
});

// Read-only NS1 validation: redaction, analysis (schema/adapter/features/fixtures), and the
// service (mock/live, persistence, sanitised fixture candidate). Asserts no NS1 mutation and
// no secret leakage.
import { describe, it, expect } from 'vitest';
import {
  loadValidationConfig,
  createValidationService,
  ValidationService,
  analyse,
  redactDeep,
  buildFixtureCandidate,
} from '../src/validation/index.js';
import { MockNs1ReadClient, type Ns1ReadClient } from '../src/ns1/index.js';
import { Ns1Error } from '../src/ns1/errors.js';
import type { NewValidationResult, ValidationResultRecord, ValidationResultRepository } from '@radar/data';

const NOW = Date.parse('2026-07-12T12:00:00Z');

const compatibleRecord = {
  id: 'r1', zone: 'rte.ie', domain: 'live.rte.ie', type: 'A', ttl: 30, use_client_subnet: true,
  answers: [{ id: 'a', answer: ['192.0.2.10'], meta: { up: true, weight: 70, note: 'Réalta' } }],
  filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }, { filter: 'select_first_n', config: { N: 1 } }],
};

describe('redactDeep', () => {
  it('redacts credential-like keys while preserving structure and order', () => {
    const input = { id: 'r', apiKey: 'secret-key', answers: [{ id: 'a', token: 'abc', answer: ['1.2.3.4'] }], meta: { authorization: 'Bearer x', note: 'keep' } };
    const out = redactDeep(input) as typeof input & { apiKey: string };
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.answers[0]).toMatchObject({ token: '[REDACTED]', answer: ['1.2.3.4'] });
    expect((out.meta as { authorization: string; note: string }).authorization).toBe('[REDACTED]');
    expect((out.meta as { note: string }).note).toBe('keep');
    expect(Object.keys(out)).toEqual(['id', 'apiKey', 'answers', 'meta']); // order preserved
  });
});

describe('analyse (record)', () => {
  it('reports a compatible record', () => {
    const a = analyse('record', compatibleRecord);
    expect(a.schemaCompatible).toBe(true);
    expect(a.adapterCompatible).toBe(true);
    expect(a.unsupportedFilters).toHaveLength(0);
    expect(['compatible', 'compatible_with_warnings']).toContain(a.overallStatus);
  });
  it('detects a missing critical field → incompatible', () => {
    const { answers, ...noAnswers } = compatibleRecord;
    void answers;
    const a = analyse('record', noAnswers);
    expect(a.missingExpectedFields).toContain('answers');
    expect(a.overallStatus).toBe('incompatible');
  });
  it('detects an unexpected field', () => {
    const a = analyse('record', { ...compatibleRecord, surprise_field: 1 });
    expect(a.unexpectedFields).toContain('surprise_field');
    expect(a.overallStatus).toBe('compatible_with_warnings');
  });
  it('detects a field-type mismatch (that the lenient schema tolerates) → partial', () => {
    const a = analyse('record', { ...compatibleRecord, answers: [{ id: 'a', answer: ['1.2.3.4'], meta: { up: true, weight: 'heavy' } }] });
    expect(a.fieldTypeMismatches.some((m) => m.path === 'answers[0].meta.weight' && m.expected === 'number')).toBe(true);
    expect(a.overallStatus).toBe('partial');
  });
  it('detects an unsupported filter → partial', () => {
    const a = analyse('record', { ...compatibleRecord, filters: [{ filter: 'up' }, { filter: 'shed_load' }] });
    expect(a.unsupportedFilters).toContain('shed_load');
    expect(a.unsupportedFeatures.some((f) => f.kind === 'filter' && f.name === 'shed_load')).toBe(true);
    expect(a.overallStatus).toBe('partial');
  });
  it('detects answer groups, feed-controlled metadata and ECS', () => {
    const grouped = analyse('record', { ...compatibleRecord, filters: [{ filter: 'select_first_group' }], regions: { east: { meta: {} } } });
    expect(grouped.answerGroupsPresent).toBe(true);
    const feed = analyse('record', { ...compatibleRecord, answers: [{ id: 'a', answer: ['1.2.3.4'], meta: { up: { feed: 'feed-x' } } }] });
    expect(feed.feedControlledMetadataPresent).toBe(true);
    expect(analyse('record', compatibleRecord).ecs).toEqual({ present: true, enabled: true });
    const { use_client_subnet, ...noEcs } = compatibleRecord;
    void use_client_subnet;
    expect(analyse('record', noEcs).ecs.present).toBe(false);
  });
  it('detects unknown metadata fields', () => {
    const a = analyse('record', { ...compatibleRecord, answers: [{ id: 'a', answer: ['1.2.3.4'], meta: { up: true, mystery_meta: 5 } }] });
    expect(a.unknownMetadataFields).toContain('mystery_meta');
  });
  it('compares against the synthetic fixture (provisional/live-only fields)', () => {
    const a = analyse('record', compatibleRecord);
    // The fixture models richer answer metadata (asn, ip_prefixes, country, geotarget filter)
    // absent from this minimal record → flagged as provisional fixture fields.
    expect(a.fixtureComparison.provisionalFixtureFields.length).toBeGreaterThan(0);
    expect(a.fixtureComparison.matches).toBe(false);
  });
});

describe('buildFixtureCandidate', () => {
  it('produces a redacted, review-flagged candidate with provenance (never a committed fixture)', () => {
    const raw = { ...compatibleRecord, secret_token: 'x', filters: [{ filter: 'shed_load' }] };
    const a = analyse('record', raw);
    const candidate = buildFixtureCandidate(raw, 'record', 'rte.ie/live.rte.ie/A', 'live', new Date(NOW).toISOString(), 'sha256:x', a);
    expect(candidate.provenance.generatedBy).toBe('radar-validation');
    expect(candidate.provenance.warning).toMatch(/CANDIDATE ONLY/);
    expect(candidate.provenance.reviewRequired.some((r) => /unsupported filter: shed_load/.test(r))).toBe(true);
    expect(candidate.provenance.reviewRequired.some((r) => /redacted credential-like field/.test(r))).toBe(true);
    expect((candidate.payload as { secret_token: string }).secret_token).toBe('[REDACTED]');
  });
});

function fakeRepo() {
  const rows: ValidationResultRecord[] = [];
  const repo: ValidationResultRepository = {
    async create(v: NewValidationResult) {
      const rec = { ...v, id: `val-${rows.length + 1}`, ranAt: v.ranAt ?? new Date(NOW) } as ValidationResultRecord;
      rows.push(rec);
      return rec;
    },
    async getById(id) { return rows.find((r) => r.id === id) ?? null; },
    async list() { return [...rows].reverse(); },
  };
  return { repo, rows };
}

describe('ValidationService', () => {
  it('validates a mock record read-only, persists a bounded result, and never mutates NS1', async () => {
    const { repo, rows } = fakeRepo();
    const client = new MockNs1ReadClient();
    const svc = new ValidationService({ client, mode: 'mock', liveValidationEnabled: false, repository: repo, now: () => NOW });
    const results = await svc.run({ zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A' }, { includeRaw: true, canViewRaw: true });
    expect(results).toHaveLength(1);
    expect(results[0].endpoint).toBe('record');
    expect(results[0].sanitisedSample).toBeDefined();
    expect(results[0].fixtureCandidate?.provenance.generatedBy).toBe('radar-validation');
    expect(rows).toHaveLength(1);
    // The read-only NS1 client exposes no write method.
    expect(Object.keys(client).some((k) => /create|update|delete|put|post|write/i.test(k))).toBe(false);
  });

  it('withholds raw/fixture candidate when the caller lacks ns1.raw.read', async () => {
    const svc = createValidationService({ client: new MockNs1ReadClient(), mode: 'mock', config: loadValidationConfig({}), now: () => NOW });
    const [r] = await svc.run({ zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A' }, { includeRaw: true, canViewRaw: false });
    expect(r.sanitisedSample).toBeUndefined();
    expect(r.fixtureCandidate).toBeUndefined();
  });

  it('blocks live validation unless explicitly enabled', () => {
    expect(new ValidationService({ client: new MockNs1ReadClient(), mode: 'live', liveValidationEnabled: false }).blockedReason()).toBe('LIVE_VALIDATION_DISABLED');
    expect(new ValidationService({ client: new MockNs1ReadClient(), mode: 'live', liveValidationEnabled: true }).blockedReason()).toBeNull();
    expect(new ValidationService({ client: new MockNs1ReadClient(), mode: 'mock', liveValidationEnabled: false }).blockedReason()).toBeNull();
  });

  it('records an unavailable result on upstream failure', async () => {
    const client: Ns1ReadClient = { listZones: async () => [], getZone: async () => { throw new Ns1Error('NS1_UPSTREAM_TIMEOUT', undefined, { transient: true }); }, getRecord: async () => ({}), getActivity: async () => [] };
    const { repo } = fakeRepo();
    const svc = new ValidationService({ client, mode: 'mock', liveValidationEnabled: false, repository: repo, now: () => NOW });
    const [r] = await svc.run({ zone: 'rte.ie' });
    expect(r.overallStatus).toBe('unavailable');
    expect(r.warnings[0]).toMatch(/NS1_UPSTREAM_TIMEOUT/);
  });

  it('never persists or returns a credential from the live payload', async () => {
    const client: Ns1ReadClient = { listZones: async () => [], getZone: async () => ({}), getRecord: async () => ({ ...compatibleRecord, x_nsone_key: 'super-secret-key', answers: [{ id: 'a', answer: ['1.2.3.4'], meta: { up: true, bearer_token: 'leak' } }] }), getActivity: async () => [] };
    const { repo, rows } = fakeRepo();
    const svc = new ValidationService({ client, mode: 'live', liveValidationEnabled: true, repository: repo, now: () => NOW });
    const [r] = await svc.run({ zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A' }, { includeRaw: true, canViewRaw: true });
    const dump = JSON.stringify(r) + JSON.stringify(rows);
    expect(dump).not.toContain('super-secret-key');
    expect(dump).not.toContain('leak');
    expect(dump).toContain('[REDACTED]');
  });

  it('validates activity when requested', async () => {
    const svc = new ValidationService({ client: new MockNs1ReadClient(), mode: 'mock', liveValidationEnabled: false, now: () => NOW });
    const results = await svc.run({ zone: 'rte.ie', includeActivity: true });
    expect(results.map((r) => r.endpoint)).toEqual(['zone', 'activity']);
  });
});

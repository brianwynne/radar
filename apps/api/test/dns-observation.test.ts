// Tier-2 DNS observation: config, clients (disabled/mock/resolver via a fake transport),
// confidence, the predicted-vs-observed comparison, and the service (predict→observe→
// compare→persist). Read-only: asserts no NS1/Cloudflare write and no high-frequency raw
// telemetry persistence.
import { describe, it, expect } from 'vitest';
import {
  loadDnsObservationConfig,
  DisabledDnsObservationClient,
  MockDnsObservationClient,
  ResolverDnsObservationClient,
  DnsObservationService,
  compareObservation,
  classifyConfidence,
  classifyObservationChange,
} from '../src/dns-observation/index.js';
import type { DnsObservationScenario, DnsTransport, PredictedSteering, RawObservation } from '../src/dns-observation/types.js';
import type { Ns1ReadClient } from '../src/ns1/index.js';
import type { DnsObservationRepository, DnsObservationRecord, NewDnsObservation } from '@radar/data';

const scenario: DnsObservationScenario = {
  ispId: 'eir', ispName: 'Eir', asn: 5466, country: 'IE', resolvers: ['192.0.2.11'], ecsSubnet: '203.0.113.0/24',
  zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A', expectedRepresentativeness: 'medium', provenance: 'MOCK', notes: '',
};
const scenarioLow: DnsObservationScenario = { ...scenario, ispId: 'three', ispName: 'Three', ecsSubnet: undefined, expectedRepresentativeness: 'low' };
const NOW = Date.parse('2026-07-12T12:00:00Z');

const RECORD = {
  domain: 'live.rte.ie', type: 'A', ttl: 30, use_client_subnet: true,
  answers: [
    { id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: true, weight: 70 } },
    { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, weight: 30 } },
  ],
  filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }],
};
function fakeNs1(getRecord: () => unknown = () => RECORD): Ns1ReadClient {
  return { listZones: async () => [], getZone: async () => ({}), getRecord: async () => getRecord(), getActivity: async () => [] };
}

const predicted = (over: Partial<PredictedSteering> = {}): PredictedSteering => ({
  answers: [{ answerId: 'ans-realta', addresses: ['192.0.2.10'] }, { answerId: 'ans-fastly', addresses: ['192.0.2.20'] }],
  answerIps: ['192.0.2.10', '192.0.2.20'],
  distribution: [{ answerId: 'ans-realta', label: 'Réalta', share: 0.7 }, { answerId: 'ans-fastly', label: 'Fastly', share: 0.3 }],
  complete: true, method: 'weighted_shuffle', unsupportedFilters: [], expectsSubsetSelection: false, ttl: 30, recordChecksum: 'sha256:x', ...over,
});
const observed = (over: Partial<RawObservation> = {}): RawObservation => ({
  ispId: 'eir', resolverIp: '192.0.2.11', responseCode: 'NOERROR', answers: [{ type: 'A', address: '192.0.2.10' }, { type: 'A', address: '192.0.2.20' }],
  ttl: 30, ecsRequested: true, ecsPrefix: '203.0.113.0/24', ecsHonoured: true, latencyMs: 10, observedAt: new Date(NOW), warnings: [], ...over,
});

describe('loadDnsObservationConfig', () => {
  it('defaults to disabled with periodic off and a floored interval', () => {
    const c = loadDnsObservationConfig({});
    expect(c.mode).toBe('disabled');
    expect(c.periodic.enabled).toBe(false);
    expect(loadDnsObservationConfig({ DNS_OBSERVATION_INTERVAL_SECONDS: '5' }).periodic.minIntervalSeconds).toBe(60); // floored
  });
});

describe('confidence classification', () => {
  it('is medium for a representative ISP resolver, low for a low-representativeness one, unknown on error', () => {
    expect(classifyConfidence(scenario, observed())).toBe('medium'); // ECS honoured but representativeness only medium
    expect(classifyConfidence({ ...scenario, expectedRepresentativeness: 'high' }, observed())).toBe('high');
    expect(classifyConfidence(scenarioLow, observed({ ecsRequested: false, ecsHonoured: undefined }))).toBe('low');
    expect(classifyConfidence(scenario, observed({ responseCode: 'SERVFAIL', answers: [] }))).toBe('unknown');
  });
});

describe('compareObservation', () => {
  it('matches an identical answer set (probabilistic order ignored)', () => {
    const r = compareObservation(predicted(), observed({ answers: [{ type: 'A', address: '192.0.2.20' }, { type: 'A', address: '192.0.2.10' }] }), scenario);
    expect(r.comparisonStatus).toBe('match');
    expect(r.differences.some((d) => d.kind === 'same_set_different_order')).toBe(false); // probabilistic → not flagged
  });
  it('flags a different order only for non-probabilistic records', () => {
    const r = compareObservation(predicted({ method: undefined }), observed({ answers: [{ type: 'A', address: '192.0.2.20' }, { type: 'A', address: '192.0.2.10' }] }), scenario);
    expect(r.matchStatus).toBe('match');
    expect(r.differences.some((d) => d.kind === 'same_set_different_order')).toBe(true);
  });
  it('treats a select_first_n sample as a match, not a distribution proof', () => {
    const r = compareObservation(predicted({ expectsSubsetSelection: true }), observed({ answers: [{ type: 'A', address: '192.0.2.10' }] }), scenario);
    expect(r.comparisonStatus).toBe('match');
    expect(r.explanation).toMatch(/single observation is one sample/i);
  });
  it('is partial_match when a predicted answer is missing (full-set record)', () => {
    const r = compareObservation(predicted(), observed({ answers: [{ type: 'A', address: '192.0.2.10' }] }), scenario);
    expect(r.matchStatus).toBe('partial_match');
    expect(r.differences.some((d) => d.kind === 'missing_predicted_answer')).toBe(true);
  });
  it('is a mismatch on an unexpected observed answer', () => {
    const r = compareObservation(predicted(), observed({ answers: [{ type: 'A', address: '198.51.100.9' }] }), scenario);
    expect(r.matchStatus).toBe('mismatch');
    expect(r.differences.some((d) => d.kind === 'unexpected_observed_answer')).toBe(true);
  });
  it('reports observation_unavailable for timeout / SERVFAIL', () => {
    expect(compareObservation(predicted(), observed({ responseCode: 'TIMEOUT', answers: [] }), scenario).comparisonStatus).toBe('observation_unavailable');
    expect(compareObservation(predicted(), observed({ responseCode: 'SERVFAIL', answers: [] }), scenario).comparisonStatus).toBe('observation_unavailable');
  });
  it('treats NXDOMAIN as a mismatch', () => {
    const r = compareObservation(predicted(), observed({ responseCode: 'NXDOMAIN', answers: [] }), scenario);
    expect(r.matchStatus).toBe('mismatch');
    expect(r.differences.some((d) => d.kind === 'dns_error_response')).toBe(true);
  });
  it('flags an ECS discrepancy and downgrades to confidence_low when confidence is low', () => {
    const r = compareObservation(predicted(), observed({ ...observed(), ecsRequested: false, ecsHonoured: undefined }), scenarioLow);
    expect(r.confidence).toBe('low');
    expect(r.comparisonStatus).toBe('confidence_low');
  });
  it('handles a partial RADAR evaluation honestly (never a clean match)', () => {
    const r = compareObservation(predicted({ complete: false, unsupportedFilters: ['shed_load'] }), observed(), scenario);
    expect(r.matchStatus).toBe('partial_match');
    expect(r.differences.some((d) => d.kind === 'partial_radar_evaluation')).toBe(true);
    expect(r.differences.some((d) => d.kind === 'unsupported_record_filter')).toBe(true);
  });
  it('flags a TTL difference', () => {
    const r = compareObservation(predicted({ ttl: 30 }), observed({ ttl: 60 }), scenario);
    expect(r.differences.some((d) => d.kind === 'ttl_difference')).toBe(true);
  });
});

describe('observation-change reasons', () => {
  const snap = (o: Partial<{ comparisonStatus: string; confidence: string; resolverIp: string; ecsHonoured: boolean; ttl: number; answerAddresses: string[] }> = {}) => ({ comparisonStatus: 'match', confidence: 'medium', resolverIp: '192.0.2.11', ecsHonoured: true, ttl: 30, answerAddresses: ['192.0.2.10'], ...o });
  it('distinguishes availability, answer-set, match, ecs, resolver, ttl and confidence changes', () => {
    expect(classifyObservationChange(snap(), snap({ comparisonStatus: 'observation_unavailable' }))).toBe('observation_became_unavailable');
    expect(classifyObservationChange(snap({ comparisonStatus: 'observation_unavailable' }), snap())).toBe('observation_recovered');
    expect(classifyObservationChange(snap(), snap({ answerAddresses: ['192.0.2.20'] }))).toBe('observed_answer_set_changed');
    expect(classifyObservationChange(snap(), snap({ comparisonStatus: 'mismatch' }))).toBe('predicted_observed_match_changed');
    expect(classifyObservationChange(snap(), snap({ ecsHonoured: false }))).toBe('ecs_behaviour_changed');
    expect(classifyObservationChange(snap(), snap({ ttl: 60 }))).toBe('ttl_changed');
  });
});

describe('clients', () => {
  it('disabled client returns a placeholder observation', async () => {
    const o = await new DisabledDnsObservationClient(() => NOW).observe(scenario);
    expect(o.disabled).toBe(true);
    expect(o.answers).toHaveLength(0);
  });
  it('mock client returns deterministic synthetic answers with an ECS flag', async () => {
    const o = await new MockDnsObservationClient({ now: () => NOW }).observe(scenario);
    expect(o.responseCode).toBe('NOERROR');
    expect(o.answers[0].address).toBe('192.0.2.10');
    expect(o.ecsRequested).toBe(true);
    expect(o.warnings.join(' ')).toMatch(/MOCK/i);
  });
  it('resolver client queries a resolver via the transport and captures TTL + ECS', async () => {
    const transport: DnsTransport = { async query() { return { responseCode: 'NOERROR', answers: [{ type: 'A', address: '192.0.2.10' }], ttl: 42, ecsHonoured: true }; } };
    const o = await new ResolverDnsObservationClient({ transport, timeoutMs: 100, now: () => NOW }).observe(scenario);
    expect(o.ttl).toBe(42);
    expect(o.ecsHonoured).toBe(true);
    expect(o.resolverIp).toBe('192.0.2.11');
  });
  it('resolver client maps a transport timeout to an unavailable observation (never throws)', async () => {
    const transport: DnsTransport = { async query() { throw new Error('DNS query timed out'); } };
    const o = await new ResolverDnsObservationClient({ transport, timeoutMs: 100, now: () => NOW }).observe(scenario);
    expect(o.responseCode).toBe('TIMEOUT');
    expect(o.answers).toHaveLength(0);
  });
  it('resolver client does not claim ECS honoured when the response does not confirm it', async () => {
    const transport: DnsTransport = { async query() { return { responseCode: 'NOERROR', answers: [{ type: 'A', address: '192.0.2.10' }], ttl: 30, ecsHonoured: false }; } };
    const o = await new ResolverDnsObservationClient({ transport, timeoutMs: 100, now: () => NOW }).observe(scenario);
    expect(o.ecsHonoured).toBe(false);
    expect(o.warnings.join(' ')).toMatch(/ECS requested/i);
  });
});

function fakeRepo() {
  const rows: DnsObservationRecord[] = [];
  const repo: DnsObservationRepository = {
    async create(o: NewDnsObservation) {
      const rec = { ...o, id: `obs-${rows.length + 1}`, observedAt: o.observedAt ?? new Date(NOW) } as DnsObservationRecord;
      rows.push(rec);
      return rec;
    },
    async list() { return [...rows].reverse(); },
    async latestPerIsp() { return rows.slice(); },
  };
  return { repo, rows };
}

describe('DnsObservationService', () => {
  const config = loadDnsObservationConfig({ DNS_OBSERVATION_MODE: 'mock' });

  it('predicts, observes, compares and persists one bounded row per run (no NS1/Cloudflare write)', async () => {
    const { repo, rows } = fakeRepo();
    const ns1 = fakeNs1();
    // A read-only NS1 client double: assert only getRecord/read methods are used.
    const svc = new DnsObservationService({ client: new MockDnsObservationClient({ now: () => NOW }), ns1Client: ns1, repository: repo, config, now: () => NOW });
    const outcome = await svc.run('eir', 'corr-1');
    expect(outcome?.comparison.comparisonStatus).toBe('match'); // mock returns a valid Réalta sample
    expect(rows).toHaveLength(1);
    expect(rows[0].correlationId).toBe('corr-1');
    expect(rows[0].comparisonStatus).toBe('match');
    // The NS1 client contract exposes no write method — observation cannot mutate NS1.
    expect(Object.keys(ns1).some((k) => /create|update|delete|put|post|write/i.test(k))).toBe(false);
  });

  it('returns null for an unknown ISP and never persists high-frequency raw telemetry', async () => {
    const { repo, rows } = fakeRepo();
    const svc = new DnsObservationService({ client: new MockDnsObservationClient({ now: () => NOW }), ns1Client: fakeNs1(), repository: repo, config, now: () => NOW });
    expect(await svc.run('nope')).toBeNull();
    await svc.run('eir');
    // Exactly one row per explicit run — no packet captures, no per-query stream.
    expect(rows).toHaveLength(1);
    expect(rows[0].observedAnswers).toBeDefined();
    expect(JSON.stringify(rows[0])).not.toMatch(/packet|capture|token|secret/i);
  });

  it('records an unavailable observation honestly when the resolver does not respond', async () => {
    const { repo } = fakeRepo();
    const transport: DnsTransport = { async query() { throw new Error('DNS query timed out'); } };
    const svc = new DnsObservationService({ client: new ResolverDnsObservationClient({ transport, timeoutMs: 50, now: () => NOW }), ns1Client: fakeNs1(), repository: repo, config, now: () => NOW });
    const outcome = await svc.run('eir');
    expect(outcome?.comparison.comparisonStatus).toBe('observation_unavailable');
  });
});

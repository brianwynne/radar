import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ChangeDetectionService, Ns1ActivityEventSource, createChangeDetectionService, isRelevantActivity, ISP_SCENARIOS } from '../src/change-detection/index.js';
import type { ChangeEventSource, SteeringChangedEvent } from '../src/change-detection/index.js';
import { Ns1Error, type Ns1ReadClient } from '../src/ns1/index.js';
import type { ActivityItem } from '../src/ns1/activity.js';
import type { Database } from '../src/database/repositories.js';
import type { AuditEvent, AuditRepository, ConfigurationSnapshot, SnapshotRepository } from '@radar/data';

const RECORD = {
  domain: 'live.rte.ie',
  type: 'CNAME',
  use_client_subnet: true,
  answers: [
    { id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: true, weight: 70, asn: [5466] } },
    { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, weight: 30 } },
  ],
  filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }, { filter: 'select_first_n', config: { N: 1 } }],
};

const relevant: ActivityItem = { id: 'act-10', occurredAt: '2026-07-07T10:00:00Z', action: 'update', resourceType: 'record', resourceKey: 'live.rte.ie/CNAME', actor: 'brian', raw: {} };
const older: ActivityItem = { id: 'act-1', occurredAt: '2026-07-06T09:00:00Z', action: 'view', resourceType: 'zone', resourceKey: 'rte.ie', raw: {} };
const irrelevantNew: ActivityItem = { id: 'act-11', occurredAt: '2026-07-07T11:00:00Z', action: 'view', resourceType: 'zone', resourceKey: 'rte.ie', raw: {} };

function fakeDb() {
  const snaps: ConfigurationSnapshot[] = [];
  const audits: AuditEvent[] = [];
  let n = 0;
  const snapshots: SnapshotRepository = {
    async create(input) {
      const s: ConfigurationSnapshot = { ...input, id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, createdAt: new Date(), metadata: input.metadata ?? {} };
      snaps.push(s);
      return s;
    },
    async getById(id) {
      return snaps.find((s) => s.id === id) ?? null;
    },
    async list() {
      return snaps.slice();
    },
  };
  const audit: AuditRepository = {
    async record(input) {
      const e: AuditEvent = { ...input, id: `a-${audits.length}`, occurredAt: new Date(), actorRoles: input.actorRoles ?? [], details: input.details ?? {} };
      audits.push(e);
      return e;
    },
    async list() {
      return audits.slice();
    },
  };
  const db: Database = { snapshots, audit, async transaction(fn) { return fn({ snapshots, audit }); } };
  return { db, snaps, audits };
}

function fakeClient(getRecord: Ns1ReadClient['getRecord']): Ns1ReadClient {
  return { listZones: async () => [], getZone: async () => ({}), getRecord, getActivity: async () => [] };
}
const source = (entries: () => ActivityItem[]): ChangeEventSource => ({ name: 'test-source', async poll() { return { entries: entries() }; } });

describe('isRelevantActivity', () => {
  it('flags config changes and ignores reads', () => {
    expect(isRelevantActivity(relevant)).toBe(true);
    expect(isRelevantActivity(older)).toBe(false); // zone/view
    expect(isRelevantActivity({ ...relevant, action: 'view' })).toBe(false);
    expect(isRelevantActivity({ ...relevant, resourceType: 'monitor' })).toBe(false);
  });
});

describe('ChangeDetectionService', () => {
  const build = (entriesRef: { list: ActivityItem[] }, client: Ns1ReadClient) => {
    const { db, snaps, audits } = fakeDb();
    const svc = new ChangeDetectionService({ source: source(() => entriesRef.list), client, database: db, mode: 'mock', now: () => Date.parse('2026-07-07T12:00:00Z') });
    return { svc, snaps, audits };
  };

  it('establishes a baseline on the first run and does no work', async () => {
    const entries = { list: [older] };
    const { svc, snaps } = build(entries, fakeClient(async () => RECORD));
    const r = await svc.runOnce();
    expect(r.baseline).toBe(true);
    expect(r.processed).toBe(0);
    expect(snaps).toHaveLength(0);
    expect(svc.status().checkpoint?.id).toBe('act-1');
  });

  it('captures a snapshot, re-evaluates all ISPs, emits an event and audits it when a relevant change appears', async () => {
    const entries = { list: [older] };
    const { svc, snaps, audits } = build(entries, fakeClient(async () => RECORD));
    const events: SteeringChangedEvent[] = [];
    svc.subscribe((e) => events.push(e));
    await svc.runOnce(); // baseline

    entries.list = [relevant, older]; // a new relevant change arrives on top
    const r = await svc.runOnce();
    expect(r.processed).toBe(1);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].createdBySubject).toBe('system:change-detection');
    expect(events).toHaveLength(1);
    expect(events[0].evaluations).toHaveLength(ISP_SCENARIOS.length);
    expect(events[0].snapshotId).toBe(snaps[0].id);
    expect(events[0].record).toMatchObject({ zone: 'rte.ie', domain: 'live.rte.ie', type: 'CNAME' });
    expect(audits.some((a) => a.action === 'steering.change.detected')).toBe(true);
    expect(audits.some((a) => a.action === 'snapshot.create')).toBe(true); // atomic capture audit
    expect(svc.status().eventsPublished).toBe(1);
    expect(svc.status().checkpoint?.id).toBe('act-10'); // advanced
  });

  it('does nothing for irrelevant activity or when there is no new activity', async () => {
    const entries = { list: [older] };
    const { svc, snaps } = build(entries, fakeClient(async () => RECORD));
    await svc.runOnce(); // baseline
    expect((await svc.runOnce()).processed).toBe(0); // no new activity
    entries.list = [irrelevantNew, older]; // a new but irrelevant (view) entry
    expect((await svc.runOnce()).processed).toBe(0);
    expect(snaps).toHaveLength(0);
  });

  it('fails safely, preserves the checkpoint and backs off, then recovers', async () => {
    const entries = { list: [older] };
    let broken = true;
    const client = fakeClient(async () => {
      if (broken) throw new Ns1Error('NS1_UPSTREAM_TIMEOUT', undefined, { transient: true });
      return RECORD;
    });
    const { svc, snaps } = build(entries, client);
    await svc.runOnce(); // baseline → checkpoint act-1
    entries.list = [relevant, older];

    const failed = await svc.runOnce();
    expect(failed.error).toBe('NS1_UPSTREAM_TIMEOUT');
    expect(snaps).toHaveLength(0);
    expect(svc.status().consecutiveFailures).toBe(1);
    expect(svc.status().lastError).toBe('NS1_UPSTREAM_TIMEOUT');
    expect(svc.status().checkpoint?.id).toBe('act-1'); // NOT advanced — will be retried

    broken = false;
    const ok = await svc.runOnce(); // retry succeeds
    expect(ok.processed).toBe(1);
    expect(snaps).toHaveLength(1);
    expect(svc.status().consecutiveFailures).toBe(0);
    expect(svc.status().checkpoint?.id).toBe('act-10');
  });

  it('the NS1 event source is wired via the factory', () => {
    const svc = createChangeDetectionService({ client: fakeClient(async () => RECORD), database: fakeDb().db, mode: 'mock' });
    expect(svc.status().source).toBe('ns1-activity-poll');
    expect(new Ns1ActivityEventSource(fakeClient(async () => RECORD)).name).toBe('ns1-activity-poll');
  });
});

describe('GET /api/v1/change-detection/status', () => {
  async function app(withService: boolean): Promise<FastifyInstance> {
    const deps: Parameters<typeof buildApp>[1] = { database: fakeDb().db };
    if (withService) deps.changeDetection = createChangeDetectionService({ client: fakeClient(async () => RECORD), database: fakeDb().db, mode: 'mock' });
    const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: 'NOC_VIEWER' }), deps);
    await a.ready();
    return a;
  }

  it('is readable by a NOC viewer (dashboard.read) and reports enabled when wired', async () => {
    const a = await app(true);
    const res = await a.inject({ method: 'GET', url: '/api/v1/change-detection/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, source: 'ns1-activity-poll' });
    await a.close();
  });

  it('reports disabled when the service is not wired; 401 unauthenticated', async () => {
    const a = await app(false);
    expect((await a.inject({ method: 'GET', url: '/api/v1/change-detection/status' })).json()).toMatchObject({ enabled: false });
    await a.close();
    const anon = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'false' }), { database: fakeDb().db });
    await anon.ready();
    expect((await anon.inject({ method: 'GET', url: '/api/v1/change-detection/status' })).statusCode).toBe(401);
    await anon.close();
  });
});

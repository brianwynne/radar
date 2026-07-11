// Change-detection persistence: durable checkpoint, per-ISP steering state and
// meaningful-only steering-change events, plus the multi-replica poller lock. Uses in-memory
// fakes for the SteeringStore and PollerLock (real-PostgreSQL durability/locking is proven in
// the integration suites).
import { describe, it, expect } from 'vitest';
import { ChangeDetectionService } from '../src/change-detection/index.js';
import type { ChangeEventSource } from '../src/change-detection/index.js';
import type { SteeringStore } from '../src/database/steering-store.js';
import type { PollerLock } from '../src/database/poller-lock.js';
import type { Ns1ReadClient } from '../src/ns1/index.js';
import type { ActivityItem } from '../src/ns1/activity.js';
import type { Database } from '../src/database/repositories.js';
import type {
  AuditEvent, AuditRepository, CheckpointRecord, CheckpointRepository, ConfigurationSnapshot,
  NewSteeringChangeEvent, NewSteeringState, SteeringChangeEvent, SteeringEventQuery, SteeringState,
  SteeringStateQuery, SnapshotRepository,
} from '@radar/data';

const RECORD = {
  domain: 'live.rte.ie', type: 'A', use_client_subnet: true,
  answers: [
    { id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: true, weight: 70 } },
    { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, weight: 30 } },
  ],
  filters: [{ filter: 'up' }, { filter: 'weighted_shuffle' }],
};
const RECORD_REALTA_DOWN = { ...RECORD, answers: [{ id: 'ans-realta', answer: ['192.0.2.10'], meta: { up: false, weight: 70 } }, { id: 'ans-fastly', answer: ['192.0.2.20'], meta: { up: true, weight: 30 } }] };

const older: ActivityItem = { id: 'act-1', occurredAt: '2026-07-06T09:00:00Z', action: 'view', resourceType: 'zone', resourceKey: 'rte.ie', raw: {} };
const relevant: ActivityItem = { id: 'act-10', occurredAt: '2026-07-07T10:00:00Z', action: 'update', resourceType: 'record', resourceKey: 'live.rte.ie/A', actor: 'brian', raw: {} };
const relevant2: ActivityItem = { id: 'act-11', occurredAt: '2026-07-07T11:00:00Z', action: 'update', resourceType: 'record', resourceKey: 'live.rte.ie/A', actor: 'brian', raw: {} };

function fakeDb() {
  const snaps: ConfigurationSnapshot[] = [];
  const audits: AuditEvent[] = [];
  let n = 0;
  const snapshots: SnapshotRepository = {
    async create(input) { const s = { ...input, id: `s-${++n}`, createdAt: new Date(), metadata: input.metadata ?? {} } as ConfigurationSnapshot; snaps.push(s); return s; },
    async getById(id) { return snaps.find((s) => s.id === id) ?? null; },
    async list() { return snaps.slice(); },
  };
  const audit: AuditRepository = {
    async record(input) { const e = { ...input, id: `a-${audits.length}`, occurredAt: new Date(), actorRoles: input.actorRoles ?? [], details: input.details ?? {} } as AuditEvent; audits.push(e); return e; },
    async list() { return audits.slice(); },
  };
  const db: Database = { snapshots, audit, async transaction(fn) { return fn({ snapshots, audit }); } };
  return { db, snaps, audits };
}

function fakeStore() {
  let checkpoint: CheckpointRecord | null = null;
  const states = new Map<string, SteeringState>();
  const events: SteeringChangeEvent[] = [];
  let eid = 0;
  const checkpoints: CheckpointRepository = {
    async get() { return checkpoint; },
    async upsert(source, checkpointId, at) { checkpoint = { source, checkpointId, checkpointOccurredAt: at, updatedAt: new Date() }; },
  };
  const stateRepo = {
    async upsert(s: NewSteeringState) { states.set(`${s.ispId}|${s.resourceKey}`, { ...s, updatedAt: new Date() }); },
    async get(ispId: string, resourceKey: string) { return states.get(`${ispId}|${resourceKey}`) ?? null; },
    async list(query?: SteeringStateQuery) {
      let out = [...states.values()];
      if (query?.ispId) out = out.filter((s) => s.ispId === query.ispId);
      if (query?.asn) out = out.filter((s) => s.asn === query.asn);
      if (query?.resourceKey) out = out.filter((s) => s.resourceKey === query.resourceKey);
      return out;
    },
  };
  const eventRepo = {
    async create(e: NewSteeringChangeEvent) { const row = { ...e, id: `e-${++eid}`, occurredAt: e.occurredAt ?? new Date() } as SteeringChangeEvent; events.push(row); return row; },
    async list(query?: SteeringEventQuery) {
      let out = [...events].reverse();
      if (query?.ispId) out = out.filter((e) => e.ispId === query.ispId);
      return out;
    },
  };
  const store: SteeringStore = { checkpoints, states: stateRepo, events: eventRepo };
  return { store, getCheckpoint: () => checkpoint, states, events };
}

function fakeClient(getRecord: () => unknown): Ns1ReadClient {
  return { listZones: async () => [], getZone: async () => ({}), getRecord: async () => getRecord(), getActivity: async () => [] };
}
const source = (entries: () => ActivityItem[]): ChangeEventSource => ({ name: 'ns1-activity-poll', async poll() { return { entries: entries() }; } });

function build(entriesRef: { list: ActivityItem[] }, record: () => unknown, extra: { steeringStore?: SteeringStore; lock?: PollerLock } = {}) {
  const { db, snaps, audits } = fakeDb();
  const svc = new ChangeDetectionService({ source: source(() => entriesRef.list), client: fakeClient(record), database: db, mode: 'mock', now: () => Date.parse('2026-07-07T12:00:00Z'), ...extra });
  return { svc, snaps, audits };
}

describe('change-detection steering persistence', () => {
  it('persists the latest state for every ISP but emits NO event on first observation (no baseline to compare)', async () => {
    const entries = { list: [older] };
    const fs = fakeStore();
    const { svc } = build(entries, () => RECORD, { steeringStore: fs.store });
    await svc.runOnce(); // baseline (persists checkpoint)
    entries.list = [relevant, older];
    const r = await svc.runOnce();
    expect(r.processed).toBe(1);
    expect(fs.states.size).toBeGreaterThan(0); // all ISP states persisted
    expect(fs.events).toHaveLength(0); // nothing to compare against yet
  });

  it('emits a steering-change event ONLY when the fingerprint changes; unchanged re-processing does not', async () => {
    const entries = { list: [older] };
    const fs = fakeStore();
    let record: unknown = RECORD;
    const { svc } = build(entries, () => record, { steeringStore: fs.store });
    await svc.runOnce(); // baseline
    entries.list = [relevant, older];
    await svc.runOnce(); // first observation → state persisted, no event
    expect(fs.events).toHaveLength(0);

    // Same record again (new activity, identical config) → no event.
    entries.list = [relevant2, relevant, older];
    await svc.runOnce();
    expect(fs.events).toHaveLength(0);

    // Réalta goes down → eligibility changes for every ISP (the `up` filter is global) → one
    // attributed event per ISP scenario.
    record = RECORD_REALTA_DOWN;
    entries.list = [{ ...relevant2, id: 'act-12', occurredAt: '2026-07-07T12:00:00Z' }, relevant2, relevant, older];
    await svc.runOnce();
    expect(fs.events.length).toBeGreaterThan(0);
    expect(fs.events.every((e) => e.reason === 'answer_became_unavailable')).toBe(true);
    expect(fs.events.every((e) => e.previousFingerprint !== e.currentFingerprint)).toBe(true);
  });

  it('persists the checkpoint and resumes from it (survives restart) instead of re-baselining', async () => {
    const entries = { list: [relevant, older] };
    const fs = fakeStore();
    const first = build(entries, () => RECORD, { steeringStore: fs.store });
    await first.svc.runOnce(); // baseline → checkpoint act-10 persisted
    expect(fs.getCheckpoint()?.checkpointId).toBe('act-10');

    // A brand-new service instance (restart) sharing the same store loads the checkpoint and
    // does NOT re-baseline; with no newer activity it processes nothing.
    const second = build(entries, () => RECORD, { steeringStore: fs.store });
    const r = await second.svc.runOnce();
    expect(r.baseline).toBeUndefined();
    expect(r.processed).toBe(0);
  });

  it('does not advance the durable checkpoint when processing fails', async () => {
    const entries = { list: [older] };
    const fs = fakeStore();
    let broken = false;
    const { svc } = build(entries, () => { if (broken) throw new Error('boom'); return RECORD; }, { steeringStore: fs.store });
    await svc.runOnce(); // baseline → checkpoint act-1
    expect(fs.getCheckpoint()?.checkpointId).toBe('act-1');
    broken = true;
    entries.list = [relevant, older];
    const failed = await svc.runOnce();
    expect(failed.error).toBeDefined();
    expect(fs.getCheckpoint()?.checkpointId).toBe('act-1'); // NOT advanced
  });
});

class FakeLock implements PollerLock {
  private _held = false;
  constructor(private owner: { holder: FakeLock | null }) {}
  get held() { return this._held; }
  async acquire() { if (this.owner.holder && this.owner.holder !== this) return false; this.owner.holder = this; this._held = true; return true; }
  async release() { if (this.owner.holder === this) this.owner.holder = null; this._held = false; }
}

describe('multi-replica poller lock', () => {
  it('only the lock holder polls; a passive replica does no work but keeps trying, then takes over on release', async () => {
    const shared = { holder: null as FakeLock | null };
    const entries = { list: [relevant, older] };

    const a = build(entries, () => RECORD, { steeringStore: fakeStore().store, lock: new FakeLock(shared) });
    const bStore = fakeStore();
    const b = build(entries, () => RECORD, { steeringStore: bStore.store, lock: new FakeLock(shared) });

    // A acquires and baselines; B is passive (no baseline, no processing).
    const ra = await a.svc.runOnce();
    expect(ra.baseline).toBe(true);
    const rb = await b.svc.runOnce();
    expect(rb.passive).toBe(true);
    expect(bStore.getCheckpoint()).toBeNull(); // B never ran the poll body

    // A shuts down and releases the lock; B can now take over and baseline.
    await a.svc.stop();
    const rb2 = await b.svc.runOnce();
    expect(rb2.passive).toBeUndefined();
    expect(rb2.baseline).toBe(true);
    expect(bStore.getCheckpoint()?.checkpointId).toBe('act-10');
  });
});

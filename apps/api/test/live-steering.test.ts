// Live Steering read-only routes: config, latest state and change events. Backed by an
// in-memory SteeringStore fake; RBAC and bounded filtering enforced server-side.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SteeringStore } from '../src/database/steering-store.js';
import type { SteeringChangeEvent, SteeringState } from '@radar/data';

function fakeStore(states: SteeringState[], events: SteeringChangeEvent[]): SteeringStore {
  return {
    checkpoints: { async get() { return null; }, async upsert() {} },
    states: {
      async upsert() {},
      async get(ispId, resourceKey) { return states.find((s) => s.ispId === ispId && s.resourceKey === resourceKey) ?? null; },
      async list(query) {
        let out = states.slice();
        if (query?.ispId) out = out.filter((s) => s.ispId === query.ispId);
        if (query?.asn) out = out.filter((s) => s.asn === query.asn);
        if (query?.resourceKey) out = out.filter((s) => s.resourceKey === query.resourceKey);
        return out;
      },
    },
    events: {
      async create() { throw new Error('read-only in test'); },
      async list(query) {
        let out = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
        if (query?.ispId) out = out.filter((e) => e.ispId === query.ispId);
        if (query?.asn) out = out.filter((e) => e.asn === query.asn);
        if (query?.since) out = out.filter((e) => e.occurredAt > query.since!);
        if (query?.before) out = out.filter((e) => e.occurredAt <= query.before!);
        return out.slice(0, query?.limit ?? 100);
      },
    },
  };
}

const state = (over: Partial<SteeringState> = {}): SteeringState => ({
  ispId: 'eir', resourceKey: 'rte.ie/live.rte.ie/A', ispName: 'Eir', asn: 5466, fingerprint: 'fp-1',
  identitySource: 'ecs', country: 'IE', matchedPrefix: '185.2.100.0/24', preferredPath: 'Eir PNI',
  eligibleAnswerIds: ['ans-realta', 'ans-fastly'], distribution: [{ answerId: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', share: 0.7 }],
  filterChain: ['up', 'weighted_shuffle'], complete: true, structuralChecksum: 'sha256:aaaa',
  evaluatedAt: new Date('2026-07-11T10:00:00Z'), updatedAt: new Date('2026-07-11T10:00:00Z'), ...over,
});

const event = (over: Partial<SteeringChangeEvent> = {}): SteeringChangeEvent => ({
  id: 'e-1', occurredAt: new Date('2026-07-11T10:00:00Z'), ispId: 'eir', ispName: 'Eir', asn: 5466,
  resourceKey: 'rte.ie/live.rte.ie/A', reason: 'answer_became_unavailable', currentFingerprint: 'fp-2',
  currentState: state(), activity: {}, ...over,
});

async function app(role: string, store?: SteeringStore, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { steeringStore: store });
  await a.ready();
  return a;
}

describe('GET /api/v1/live-steering/config', () => {
  it('returns configured ISPs, records and the reason vocabulary to a NOC viewer', async () => {
    const a = await app('NOC_VIEWER', fakeStore([], []));
    const res = await a.inject({ method: 'GET', url: '/api/v1/live-steering/config' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.maxSelectableIsps).toBe(6);
    expect(b.provenance.label).toBe('Current Expected DNS Steering');
    expect(b.isps.find((i: { id: string }) => i.id === 'eir')).toMatchObject({ asn: 5466, preferredPath: 'Eir PNI' });
    expect(b.reasons.find((r: { id: string }) => r.id === 'unknown_structural_change').label).toBe('Reason not yet attributable');
    await a.close();
  });

  it('401 unauthenticated', async () => {
    const a = await app('NOC_VIEWER', fakeStore([], []), false);
    expect((await a.inject({ method: 'GET', url: '/api/v1/live-steering/config' })).statusCode).toBe(401);
    await a.close();
  });
});

describe('GET /api/v1/live-steering/state', () => {
  it('returns persisted state and filters by isp/asn/record', async () => {
    const store = fakeStore([state(), state({ ispId: 'virgin', ispName: 'Virgin Media', asn: 6830 })], []);
    const a = await app('NOC_VIEWER', store);
    expect((await a.inject({ url: '/api/v1/live-steering/state' })).json().count).toBe(2);
    expect((await a.inject({ url: '/api/v1/live-steering/state?isp=eir' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/live-steering/state?asn=6830' })).json().count).toBe(1);
    const one = (await a.inject({ url: '/api/v1/live-steering/state?isp=eir' })).json();
    expect(one.items[0]).toMatchObject({ ispId: 'eir', preferredPath: 'Eir PNI', identitySource: 'ecs' });
    expect(one.provenance.label).toBe('Current Expected DNS Steering');
    await a.close();
  });

  it('rejects a bad asn (400) and 503 when persistence is not configured', async () => {
    const a = await app('NOC_VIEWER', fakeStore([], []));
    expect((await a.inject({ url: '/api/v1/live-steering/state?asn=notanumber' })).statusCode).toBe(400);
    await a.close();
    const b = await app('NOC_VIEWER', undefined);
    expect((await b.inject({ url: '/api/v1/live-steering/state' })).statusCode).toBe(503);
    await b.close();
  });
});

describe('GET /api/v1/live-steering/events', () => {
  it('returns events (newest first) with an attributed reason label, filters and bounds', async () => {
    const store = fakeStore(
      [],
      [
        event({ id: 'e-1', occurredAt: new Date('2026-07-11T10:00:00Z') }),
        event({ id: 'e-2', occurredAt: new Date('2026-07-11T11:00:00Z'), ispId: 'virgin', ispName: 'Virgin Media', asn: 6830, reason: 'unknown_structural_change' }),
      ],
    );
    const a = await app('NOC_VIEWER', store);
    const all = (await a.inject({ url: '/api/v1/live-steering/events' })).json();
    expect(all.count).toBe(2);
    expect(all.items[0].id).toBe('e-2'); // newest first
    expect(all.items[0].reasonLabel).toBe('Reason not yet attributable');
    expect((await a.inject({ url: '/api/v1/live-steering/events?isp=eir' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/live-steering/events?limit=1' })).json().count).toBe(1);
    expect((await a.inject({ url: '/api/v1/live-steering/events?since=2026-07-11T10:30:00Z' })).json().count).toBe(1);
    await a.close();
  });

  it('rejects limit over 500 (400)', async () => {
    const a = await app('NOC_VIEWER', fakeStore([], []));
    expect((await a.inject({ url: '/api/v1/live-steering/events?limit=999' })).statusCode).toBe(400);
    await a.close();
  });

  it('401 unauthenticated', async () => {
    const a = await app('NOC_VIEWER', fakeStore([], []), false);
    expect((await a.inject({ url: '/api/v1/live-steering/events' })).statusCode).toBe(401);
    await a.close();
  });
});

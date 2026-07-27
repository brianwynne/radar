// FAST SUPPLEMENTARY coverage using pg-mem (in-memory PostgreSQL). This is NOT
// authoritative PostgreSQL validation — pg-mem emulates and differs in places (no real
// transaction rollback, stricter AST-coverage guard). The authoritative proof lives in
// test/integration/postgres.integration.test.ts against a real server.
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import {
  applyMigrations,
  loadMigrations,
  migrationStatus,
  migrationChecksum,
  MigrationChecksumError,
  PostgresSnapshotRepository,
  PostgresAuditRepository,
  PostgresCheckpointRepository,
  PostgresSteeringStateRepository,
  PostgresSteeringEventRepository,
  PostgresDnsObservationRepository,
  PostgresPniBandwidthRepository,
  PostgresRisEventRepository,
  PostgresDeliverySampleRepository,
  PostgresStreamAssuranceRepository,
  PostgresValidationResultRepository,
  PostgresConnectorSettingsRepository,
  type NewSteeringState,
  type NewDnsObservation,
  type NewValidationResult,
  type Queryable,
} from '../src/index.js';

async function freshDb(): Promise<{ mem: IMemoryDb; db: Queryable }> {
  // noAstCoverageCheck relaxes a pg-mem-only strictness (re-running CREATE TABLE IF NOT
  // EXISTS trips its "unread AST" guard). Real PostgreSQL treats it as a no-op.
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Queryable;
  await applyMigrations(db, loadMigrations());
  return { mem, db };
}

const sampleSnapshot = {
  sourceSystem: 'ns1',
  resourceKind: 'record',
  resourceKey: 'live.rte.ie/A',
  sourceEndpoint: 'https://api.nsone.net/v1/zones/rte.ie/live.rte.ie/A',
  retrievedAt: new Date('2026-07-01T10:00:00.000Z'),
  createdBySubject: 'user-oid-1',
  label: 'demo capture',
  rawPayload: { answers: [{ answer: ['realta'] }], filters: [{ filter: 'up' }] },
  canonicalPayload: { answers: ['realta'] },
  rawChecksum: 'sha256:abc',
  structuralChecksum: 'sha256:struct',
  metadata: { note: 'nested', tags: ['a', 'b'] },
};

describe('migrations (pg-mem)', () => {
  it('applies the initial schema, is idempotent, and reports status', async () => {
    const { db } = await freshDb();
    expect(await applyMigrations(db, loadMigrations())).toEqual([]); // nothing left
    const status = await migrationStatus(db, loadMigrations());
    expect(status).toEqual([
      { version: '0001_init', filename: '0001_init.sql', applied: true, checksumMatches: true },
      { version: '0002_live_steering', filename: '0002_live_steering.sql', applied: true, checksumMatches: true },
      { version: '0003_dns_observations', filename: '0003_dns_observations.sql', applied: true, checksumMatches: true },
      { version: '0004_ns1_validations', filename: '0004_ns1_validations.sql', applied: true, checksumMatches: true },
      { version: '0005_connector_settings', filename: '0005_connector_settings.sql', applied: true, checksumMatches: true },
      { version: '0006_bgptools', filename: '0006_bgptools.sql', applied: true, checksumMatches: true },
      { version: '0007_pni_bandwidth', filename: '0007_pni_bandwidth.sql', applied: true, checksumMatches: true },
      { version: '0008_pni_bandwidth_classification', filename: '0008_pni_bandwidth_classification.sql', applied: true, checksumMatches: true },
      { version: '0009_ris_events', filename: '0009_ris_events.sql', applied: true, checksumMatches: true },
      { version: '0010_delivery_samples', filename: '0010_delivery_samples.sql', applied: true, checksumMatches: true },
      { version: '0011_stream_assurance', filename: '0011_stream_assurance.sql', applied: true, checksumMatches: true },
      { version: '0012_stream_assurance_alerts', filename: '0012_stream_assurance_alerts.sql', applied: true, checksumMatches: true },
    ]);
  });

  it('rejects an already-applied migration whose checksum changed', async () => {
    const { db } = await freshDb();
    const tampered = loadMigrations().map((m) => ({ ...m, sql: `${m.sql}\n-- altered`, checksum: migrationChecksum(`${m.sql}\n-- altered`) }));
    await expect(applyMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });
});

describe('PostgresSnapshotRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });

  it('creates, round-trips via getById, and returns null for unknown ids', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create(sampleSnapshot);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBeInstanceOf(Date);
    const fetched = await repo.getById(created.id);
    expect(fetched?.rawPayload).toEqual(sampleSnapshot.rawPayload);
    expect(fetched?.metadata).toEqual(sampleSnapshot.metadata);
    expect(await repo.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists filtered by identity/source, newest first, bounded', async () => {
    const repo = new PostgresSnapshotRepository(db);
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-01T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, retrievedAt: new Date('2026-07-03T00:00:00.000Z') });
    await repo.create({ ...sampleSnapshot, resourceKey: 'other/A' });
    const forRecord = await repo.list({ resourceKind: 'record', resourceKey: 'live.rte.ie/A' });
    expect(forRecord).toHaveLength(2);
    expect(forRecord[0].retrievedAt.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(await repo.list({ sourceSystem: 'ns1' })).toHaveLength(3);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });

  it('updateLabel renames the label only (trims, clears on blank) and 404s unknown ids', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create({ ...sampleSnapshot, label: undefined });
    const renamed = await repo.updateLabel(created.id, '  before failover  ');
    expect(renamed?.label).toBe('before failover'); // trimmed
    expect(renamed?.rawChecksum).toBe(created.rawChecksum); // payload/checksum untouched
    expect((await repo.getById(created.id))?.label).toBe('before failover');
    expect((await repo.updateLabel(created.id, '   '))?.label).toBeUndefined(); // blank clears
    expect(await repo.updateLabel('00000000-0000-0000-0000-000000000000', 'x')).toBeNull();
  });

  it('delete removes a snapshot and returns it; 404s unknown ids', async () => {
    const repo = new PostgresSnapshotRepository(db);
    const created = await repo.create(sampleSnapshot);
    const deleted = await repo.delete(created.id);
    expect(deleted?.id).toBe(created.id);
    expect(await repo.getById(created.id)).toBeNull(); // gone
    expect(await repo.delete(created.id)).toBeNull(); // already deleted
    expect(await repo.delete('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('PostgresAuditRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });

  it('records roles (text[]) and details (jsonb), defaulting empties, and filters lists', async () => {
    const repo = new PostgresAuditRepository(db);
    const ev = await repo.record({
      actorSubject: 'user-oid-1',
      actorRoles: ['ENGINEER', 'NOC_VIEWER'],
      action: 'snapshot.create',
      outcome: 'success',
      correlationId: 'corr-123',
      details: { fields: 3 },
    });
    expect(ev.actorRoles).toEqual(['ENGINEER', 'NOC_VIEWER']);
    expect(ev.details).toEqual({ fields: 3 });

    await repo.record({ action: 'auth.login', outcome: 'failure', actorSubject: 'b' });
    const [login] = await repo.list({ action: 'auth.login' });
    expect(login.actorRoles).toEqual([]);
    expect(login.details).toEqual({});
    expect(await repo.list({ correlationId: 'corr-123' })).toHaveLength(1);
  });
});

const steeringState = (over: Partial<NewSteeringState> = {}): NewSteeringState => ({
  ispId: 'eir',
  resourceKey: 'rte.ie/live.rte.ie/A',
  ispName: 'Eir',
  asn: 5466,
  fingerprint: 'fp-1',
  identitySource: 'ecs',
  country: 'IE',
  matchedPrefix: '185.2.100.0/24',
  preferredPath: 'Eir PNI',
  eligibleAnswerIds: ['ans-realta', 'ans-fastly'],
  distribution: [{ answerId: 'ans-realta', label: 'Réalta', deliveryPlatform: 'Réalta', share: 0.7 }],
  filterChain: ['up', 'weighted_shuffle'],
  complete: true,
  structuralChecksum: 'sha256:aaaa',
  evaluatedAt: new Date('2026-07-11T10:00:00.000Z'),
  ...over,
});

describe('PostgresCheckpointRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    db = (await freshDb()).db;
  });

  it('upserts one row per source and updates in place', async () => {
    const repo = new PostgresCheckpointRepository(db);
    expect(await repo.get('ns1-activity-poll')).toBeNull();
    await repo.upsert('ns1-activity-poll', 'act-1', new Date('2026-07-11T10:00:00.000Z'));
    await repo.upsert('ns1-activity-poll', 'act-2', new Date('2026-07-11T11:00:00.000Z'));
    const cp = await repo.get('ns1-activity-poll');
    expect(cp?.checkpointId).toBe('act-2');
  });
});

describe('PostgresSteeringStateRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    db = (await freshDb()).db;
  });

  it('upserts on (isp_id, resource_key), round-trips JSON, filters and lists', async () => {
    const repo = new PostgresSteeringStateRepository(db);
    await repo.upsert(steeringState());
    await repo.upsert(steeringState({ fingerprint: 'fp-2', eligibleAnswerIds: ['ans-fastly'] }));
    await repo.upsert(steeringState({ ispId: 'virgin', ispName: 'Virgin Media', asn: 6830, fingerprint: 'fp-v' }));
    const eir = await repo.get('eir', 'rte.ie/live.rte.ie/A');
    expect(eir?.fingerprint).toBe('fp-2');
    expect(eir?.eligibleAnswerIds).toEqual(['ans-fastly']);
    expect(eir?.filterChain).toEqual(['up', 'weighted_shuffle']);
    expect(await repo.list()).toHaveLength(2);
    expect(await repo.list({ ispId: 'virgin' })).toHaveLength(1);
  });
});

describe('PostgresSteeringEventRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    db = (await freshDb()).db;
  });

  it('creates events, round-trips previous/current state, filters and bounds', async () => {
    const repo = new PostgresSteeringEventRepository(db);
    const prev = steeringState({ fingerprint: 'fp-1' });
    const curr = steeringState({ fingerprint: 'fp-2', eligibleAnswerIds: ['ans-fastly'] });
    const created = await repo.create({
      ispId: 'eir', ispName: 'Eir', asn: 5466, resourceKey: 'rte.ie/live.rte.ie/A', reason: 'answer_became_unavailable',
      previousFingerprint: 'fp-1', currentFingerprint: 'fp-2', previousState: prev, currentState: curr,
      previousChecksum: 'sha256:aaaa', currentChecksum: 'sha256:bbbb', activity: { action: 'update' },
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    const [ev] = await repo.list({ ispId: 'eir' });
    expect(ev.reason).toBe('answer_became_unavailable');
    // previous/current state are opaque JSONB snapshots (Dates serialise to ISO strings).
    expect(ev.previousState).toEqual(JSON.parse(JSON.stringify(prev)));
    expect(ev.currentChecksum).toBe('sha256:bbbb');
    expect(await repo.list({ asn: 5466 })).toHaveLength(1);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });
});

const dnsObservation = (over: Partial<NewDnsObservation> = {}): NewDnsObservation => ({
  ispId: 'eir',
  ispName: 'Eir',
  asn: 5466,
  resolverIp: '192.0.2.11',
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  recordType: 'A',
  ecsRequested: true,
  ecsPrefix: '203.0.113.0/24',
  ecsHonoured: true,
  responseCode: 'NOERROR',
  observedAnswers: [{ type: 'A', address: '192.0.2.10' }],
  predictedAnswers: [{ answerId: 'ans-realta', addresses: ['192.0.2.10'] }],
  comparisonStatus: 'match',
  confidence: 'medium',
  ttl: 30,
  latencyMs: 12,
  recordChecksum: 'sha256:aaaa',
  explanation: 'ok',
  warnings: [],
  provenance: { source: 'radar', label: 'Observed DNS answer' },
  correlationId: 'corr-1',
  ...over,
});

describe('PostgresDnsObservationRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    db = (await freshDb()).db;
  });

  it('creates observations, round-trips JSONB, filters, bounds and returns latest per ISP', async () => {
    const repo = new PostgresDnsObservationRepository(db);
    const created = await repo.create(dnsObservation());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.observedAnswers).toEqual([{ type: 'A', address: '192.0.2.10' }]);
    expect(created.provenance).toEqual({ source: 'radar', label: 'Observed DNS answer' });

    await repo.create(dnsObservation({ comparisonStatus: 'mismatch', responseCode: 'NXDOMAIN' }));
    await repo.create(dnsObservation({ ispId: 'virgin', ispName: 'Virgin', asn: 6830 }));

    expect(await repo.list()).toHaveLength(3);
    expect(await repo.list({ ispId: 'eir' })).toHaveLength(2);
    expect(await repo.list({ comparisonStatus: 'mismatch' })).toHaveLength(1);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
    const latest = await repo.latestPerIsp();
    expect(latest.map((r) => r.ispId).sort()).toEqual(['eir', 'virgin']); // one row per ISP
  });
});

const validationResult = (over: Partial<NewValidationResult> = {}): NewValidationResult => ({
  endpoint: 'record',
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  recordType: 'A',
  sourceMode: 'live',
  retrievedAt: new Date('2026-07-12T10:00:00.000Z'),
  rawChecksum: 'sha256:aaaa',
  structuralChecksum: 'sha256:bbbb',
  overallStatus: 'compatible_with_warnings',
  schemaCompatible: true,
  adapterCompatible: true,
  supportedFilters: ['up', 'weighted_shuffle'],
  unsupportedFilters: [],
  unknownFields: { metadata: ['mystery'], unexpected: [], features: [] },
  missingFields: [],
  typeMismatches: [],
  answerGroupsPresent: false,
  feedControlledPresent: true,
  ecs: { present: true, enabled: true },
  fixtureComparison: { provisionalFixtureFields: ['answers[].meta.asn'], liveOnlyFields: [], typeMismatches: [], matches: false },
  warnings: ['réalta note'],
  sanitisedSample: { id: 'r', apiKey: '[REDACTED]' },
  correlationId: 'corr-1',
  ...over,
});

describe('PostgresValidationResultRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => {
    db = (await freshDb()).db;
  });

  it('creates results, round-trips JSONB, fetches by id, filters and bounds', async () => {
    const repo = new PostgresValidationResultRepository(db);
    const created = await repo.create(validationResult());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.ecs).toEqual({ present: true, enabled: true });
    expect(created.sanitisedSample).toEqual({ id: 'r', apiKey: '[REDACTED]' });
    expect(await repo.getById(created.id)).not.toBeNull();
    expect(await repo.getById('00000000-0000-0000-0000-000000000000')).toBeNull();

    await repo.create(validationResult({ overallStatus: 'incompatible' }));
    expect(await repo.list()).toHaveLength(2);
    expect(await repo.list({ overallStatus: 'incompatible' })).toHaveLength(1);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });
});

describe('PostgresConnectorSettingsRepository (pg-mem)', () => {
  it('honours retain / replace / clear token actions', async () => {
    const { db } = await freshDb();
    const repo = new PostgresConnectorSettingsRepository(db);
    const ct = Buffer.from('ciphertext'), nn = Buffer.from('nonce-1'), tg = Buffer.from('tag-1');

    // Insert with retain → no token stored.
    let r = await repo.upsert({ connector: 'cloudvision', enabled: true, mode: 'live', endpoint: 'https://cvp', verifyTls: true, edgeDeviceIds: 'D1', updatedBy: 'eng', tokenAction: 'retain' });
    expect(r.tokenCiphertext).toBeNull();
    expect(r.tokenSetAt).toBeNull();

    // Replace → token stored, token_set_at populated.
    r = await repo.upsert({ connector: 'cloudvision', enabled: true, mode: 'live', endpoint: 'https://cvp', verifyTls: true, edgeDeviceIds: 'D1', updatedBy: 'eng', tokenAction: 'replace', tokenCiphertext: ct, tokenNonce: nn, tokenTag: tg });
    expect(r.tokenCiphertext).not.toBeNull();
    expect(Buffer.from(r.tokenCiphertext as Buffer).toString()).toBe('ciphertext');
    expect(r.tokenSetAt).not.toBeNull();

    // Retain → non-token fields update, token unchanged.
    r = await repo.upsert({ connector: 'cloudvision', enabled: true, mode: 'live', endpoint: 'https://cvp2', verifyTls: false, edgeDeviceIds: 'D1,D2', updatedBy: 'eng2', tokenAction: 'retain' });
    expect(r.endpoint).toBe('https://cvp2');
    expect(r.verifyTls).toBe(false);
    expect(Buffer.from(r.tokenCiphertext as Buffer).toString()).toBe('ciphertext'); // preserved

    // Clear → token nulled.
    r = await repo.upsert({ connector: 'cloudvision', enabled: false, mode: 'mock', endpoint: null, verifyTls: true, edgeDeviceIds: null, updatedBy: 'eng', tokenAction: 'clear' });
    expect(r.tokenCiphertext).toBeNull();
    expect(r.tokenSetAt).toBeNull();

    const got = await repo.get('cloudvision');
    expect(got?.mode).toBe('mock');
    expect(got?.tokenCiphertext).toBeNull();
  });
});

describe('PostgresPniBandwidthRepository (pg-mem)', () => {
  // NOTE: range() uses to_timestamp/extract(epoch)/avg bucketing which pg-mem cannot parse, so the
  // authoritative range/averaging proof lives in the real-PostgreSQL integration suite. Here we cover
  // the simple insert + idempotency + prune paths pg-mem does support.
  let db: Queryable;
  beforeEach(async () => { ({ db } = await freshDb()); });

  const count = async (): Promise<number> =>
    Number((await db.query<{ c: number }>('SELECT count(*)::int AS c FROM pni_bandwidth_samples')).rows[0].c);

  // ON CONFLICT DO NOTHING rowCount is a real-PG behaviour pg-mem does not model faithfully, so the
  // idempotency assertion lives in the integration suite; here we cover insert + prune counts.
  it('inserts a batch and prunes rows older than the cutoff', async () => {
    const repo = new PostgresPniBandwidthRepository(db);
    const t0 = new Date('2026-07-26T12:00:00.000Z');
    const old = new Date('2026-07-25T00:00:00.000Z');
    expect(await repo.insertBatch(t0, [
      { deviceId: 'JPN1', interfaceName: 'Ethernet1', provider: 'Eir', linkType: 'PRIVATE_PEERING', datacentre: 'Citywest', inBps: 1_000_000, outBps: 2_000_000 },
      { deviceId: 'JPN1', interfaceName: 'Ethernet2', provider: 'Sky', linkType: 'PRIVATE_PEERING', datacentre: 'Citywest', inBps: 500_000, outBps: 4_000_000 },
    ])).toBe(2);
    await repo.insertBatch(old, [{ deviceId: 'JPN1', interfaceName: 'Ethernet1', provider: 'Eir', linkType: 'PRIVATE_PEERING', datacentre: 'Citywest', inBps: 9, outBps: 9 }]);
    expect(await count()).toBe(3);

    // Prune everything before 2026-07-26 → only the old (2026-07-25) row goes.
    expect(await repo.prune(new Date('2026-07-26T00:00:00Z'))).toBe(1);
    expect(await count()).toBe(2);
  });

  it('an empty batch writes nothing', async () => {
    expect(await new PostgresPniBandwidthRepository(db).insertBatch(new Date(), [])).toBe(0);
    expect(await count()).toBe(0);
  });
});

describe('PostgresRisEventRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => { ({ db } = await freshDb()); });

  it('upserts events (idempotent on id), reads newest-first with filters, and prunes', async () => {
    const repo = new PostgresRisEventRepository(db);
    const t = (iso: string) => new Date(iso);
    expect(await repo.upsertBatch([
      { id: 'a', kind: 'announcement', prefix: '89.207.56.0/21', originAsn: 41073, peerAsn: 174, path: [174, 41073], observationCount: 3, firstAt: t('2026-07-27T10:00:00Z'), lastAt: t('2026-07-27T10:01:00Z') },
      { id: 'w', kind: 'withdrawal', prefix: '89.207.57.0/24', originAsn: null, peerAsn: 3356, path: [], observationCount: 1, firstAt: t('2026-07-27T09:00:00Z'), lastAt: t('2026-07-27T09:00:00Z') },
    ])).toBe(2);

    // Re-upsert 'a' with a later observation — no new row, updated state.
    await repo.upsertBatch([{ id: 'a', kind: 'announcement', prefix: '89.207.56.0/21', originAsn: 41073, peerAsn: 174, path: [174, 41073], observationCount: 9, firstAt: t('2026-07-27T10:00:00Z'), lastAt: t('2026-07-27T10:05:00Z') }]);

    const all = await repo.range({ since: t('2026-07-27T00:00:00Z') });
    expect(all.map((e) => e.id)).toEqual(['a', 'w']); // newest last_at first
    expect(all[0].observationCount).toBe(9);
    expect(all[0].path).toEqual([174, 41073]);

    // Filter by kind and prefix.
    expect((await repo.range({ since: t('2026-07-27T00:00:00Z'), kind: 'withdrawal' })).map((e) => e.id)).toEqual(['w']);
    expect((await repo.range({ since: t('2026-07-27T00:00:00Z'), prefix: '89.207.56.0/21' })).map((e) => e.id)).toEqual(['a']);

    // Connection transitions.
    await repo.recordConnectionState({ at: t('2026-07-27T08:00:00Z'), state: 'disconnected', detail: 'collector reset' });
    await repo.recordConnectionState({ at: t('2026-07-27T08:00:00Z'), state: 'disconnected', detail: 'dup' }); // idempotent on instant
    await repo.recordConnectionState({ at: t('2026-07-27T08:05:00Z'), state: 'connected', detail: null });
    const conns = await repo.connectionChanges({ since: t('2026-07-27T00:00:00Z') });
    expect(conns.map((c) => c.state)).toEqual(['connected', 'disconnected']); // newest first

    // Prune everything before 2026-07-27T09:30 → the withdrawal (09:00) + both conn rows go.
    expect(await repo.prune(t('2026-07-27T09:30:00Z'))).toBe(3);
    expect((await repo.range({ since: t('2026-07-27T00:00:00Z') })).map((e) => e.id)).toEqual(['a']);
  });

  it('an empty batch writes nothing', async () => {
    expect(await new PostgresRisEventRepository(db).upsertBatch([])).toBe(0);
  });
});

describe('PostgresDeliverySampleRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => { ({ db } = await freshDb()); });

  it('inserts samples, averages over a window, and prunes', async () => {
    const repo = new PostgresDeliverySampleRepository(db);
    const t = (iso: string) => new Date(iso);
    await repo.insert({ at: t('2026-07-27T10:00:00Z'), realtaBps: 100, commercialBps: 20, totalBps: 120 });
    await repo.insert({ at: t('2026-07-27T10:00:30Z'), realtaBps: 200, commercialBps: 40, totalBps: 240 });
    await repo.insert({ at: t('2026-07-27T08:00:00Z'), realtaBps: 999, commercialBps: 999, totalBps: 1998 }); // outside window

    const avg = await repo.averageSince(t('2026-07-27T09:00:00Z'));
    expect(avg.sampleCount).toBe(2);
    expect(avg.avgRealtaBps).toBe(150);
    expect(avg.avgCommercialBps).toBe(30);
    expect(avg.avgTotalBps).toBe(180);

    // Empty window → nulls, count 0.
    const none = await repo.averageSince(t('2026-07-27T12:00:00Z'));
    expect(none.sampleCount).toBe(0);
    expect(none.avgTotalBps).toBeNull();

    expect(await repo.prune(t('2026-07-27T09:00:00Z'))).toBe(1); // the 08:00 row
  });
});

describe('PostgresStreamAssuranceRepository (pg-mem)', () => {
  let db: Queryable;
  beforeEach(async () => { ({ db } = await freshDb()); });

  it('upserts profiles (jsonb config round-trips) and stores/reads run snapshots', async () => {
    const repo = new PostgresStreamAssuranceRepository(db);
    await repo.upsertProfile({ id: 'rte-one', name: 'RTÉ One', config: { endpoints: [{ endpointId: 'akamai', provider: 'akamai' }], tags: ['production'] } });
    await repo.upsertProfile({ id: 'rte-one', name: 'RTÉ One HD', config: { endpoints: [], tags: ['production', 'event'] } }); // update

    const profiles = await repo.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('RTÉ One HD');
    expect((profiles[0].config as { tags: string[] }).tags).toEqual(['production', 'event']);

    const t = (iso: string) => new Date(iso);
    await repo.insertRun({ id: 'run-1', profileId: 'rte-one', startedAt: t('2026-07-27T10:00:00Z'), finishedAt: t('2026-07-27T10:00:02Z'), mode: 'normal', status: 'findings', observations: [{ endpointId: 'akamai', kid: 'abc' }], findings: [{ ruleId: 'SA-CDN-001', classification: 'ORIGIN_VARIANT_MISMATCH' }], findingCount: 1 });
    await repo.insertRun({ id: 'run-2', profileId: 'rte-one', startedAt: t('2026-07-27T10:05:00Z'), finishedAt: t('2026-07-27T10:05:01Z'), mode: 'normal', status: 'ok', observations: [], findings: [], findingCount: 0 });

    const latest = await repo.latestRun('rte-one');
    expect(latest?.id).toBe('run-2'); // newest first
    expect(latest?.status).toBe('ok');

    const runs = await repo.listRuns('rte-one', 10);
    expect(runs.map((r) => r.id)).toEqual(['run-2', 'run-1']);
    expect((runs[1].findings as { ruleId: string }[])[0].ruleId).toBe('SA-CDN-001');

    expect(await repo.pruneRuns(t('2026-07-27T10:02:00Z'))).toBe(1); // removes run-1
    await repo.deleteProfile('rte-one');
    expect(await repo.getProfile('rte-one')).toBeNull();
  });

  it('durable alerts: upsert (idempotent on id), acknowledge, resolve, list-open and prune', async () => {
    const repo = new PostgresStreamAssuranceRepository(db);
    const t = (iso: string) => new Date(iso);
    const alert = { id: 'rte-one:akamai:SA-CDN-001:ORIGIN_VARIANT_MISMATCH', profileId: 'rte-one', endpointId: 'akamai', ruleId: 'SA-CDN-001', classification: 'ORIGIN_VARIANT_MISMATCH', severity: 'critical' as const, explanation: 'x', remediation: 'y', evidence: { hostHeaderMismatch: true } };
    await repo.upsertAlert({ ...alert, state: 'observed', consecutivePresent: 1, consecutiveAbsent: 0, occurrences: 1, firstObserved: t('2026-07-27T10:00:00Z'), lastObserved: t('2026-07-27T10:00:00Z'), updatedAt: t('2026-07-27T10:00:00Z') });
    await repo.upsertAlert({ ...alert, state: 'active', consecutivePresent: 3, consecutiveAbsent: 0, occurrences: 3, firstObserved: t('2026-07-27T10:00:00Z'), lastObserved: t('2026-07-27T10:02:00Z'), updatedAt: t('2026-07-27T10:02:00Z') });

    let open = await repo.listOpenAlerts('rte-one');
    expect(open).toHaveLength(1);
    expect(open[0].state).toBe('active');
    expect(open[0].occurrences).toBe(3);
    expect((open[0].evidence as { hostHeaderMismatch: boolean }).hostHeaderMismatch).toBe(true);

    const acked = await repo.acknowledgeAlert(alert.id, 'noc-1');
    expect(acked?.state).toBe('acknowledged');
    expect(acked?.acknowledgedBy).toBe('noc-1');

    await repo.resolveAlert(alert.id);
    expect((await repo.listOpenAlerts('rte-one'))).toHaveLength(0); // resolved is not open
    expect((await repo.getAlert(alert.id))?.state).toBe('resolved');

    expect(await repo.pruneAlerts(t('2100-01-01T00:00:00Z'))).toBe(1); // resolved + old enough
  });
});

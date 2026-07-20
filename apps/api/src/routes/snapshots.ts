// Configuration snapshots (read + capture; RADAR never writes to NS1). Capture fetches a
// record via the read-only NS1 client, preserves the raw payload, generates canonical
// JSON + SHA-256 checksums, and persists the snapshot and its audit event ATOMICALLY.
// Routes: capture/history are record-scoped; detail/compare are id-scoped.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConfigurationSnapshot } from '@radar/data';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { Ns1Config } from '../ns1/config.js';
import type { Database } from '../database/repositories.js';
import { Ns1Error } from '../ns1/errors.js';
import { canonicalise, diffJson, rawChecksum, structuralChecksum, summariseRecordDiff } from '../ns1/snapshot.js';
import { captureRecordSnapshot } from '../ns1/snapshot-capture.js';
import { requirePermission } from '../auth/guards.js';
import { buildProvenance, resolveEffectiveNs1, sendNs1Error, type Ns1Connection } from './ns1-helpers.js';

export interface SnapshotRouteOptions {
  client: Ns1ReadClient;
  ns1: Ns1Config;
  database?: Database;
  /** When present, the effective (live⇄mock) connector mode is read from it per-request so a
   *  snapshot captured after an Engineer switches NS1 to live is labelled live, not the startup
   *  mode. Falls back to the static `ns1` config when absent. */
  ns1Connection?: Ns1Connection;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const doc = (summary: string) => ({ tags: ['snapshots'], summary, security: [{ bearerAuth: [] }] }) as const;

function summary(s: ConfigurationSnapshot) {
  return {
    id: s.id,
    sourceSystem: s.sourceSystem,
    resourceKind: s.resourceKind,
    resourceKey: s.resourceKey,
    sourceEndpoint: s.sourceEndpoint,
    retrievedAt: s.retrievedAt,
    createdAt: s.createdAt,
    createdBySubject: s.createdBySubject,
    label: s.label,
    rawChecksum: s.rawChecksum,
    structuralChecksum: s.structuralChecksum,
    metadata: s.metadata,
  };
}

const detail = (s: ConfigurationSnapshot) => ({ ...summary(s), rawPayload: s.rawPayload, canonicalPayload: s.canonicalPayload });

function requireDb(database: Database | undefined, req: FastifyRequest, reply: FastifyReply): database is Database {
  if (database) return true;
  void reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Snapshot persistence is not configured.', correlationId: req.id });
  return false;
}

export const snapshotRoutes: FastifyPluginAsync<SnapshotRouteOptions> = async (app, opts) => {
  const { client, ns1, database, ns1Connection } = opts;
  // The connector's effective mode/base — reflects runtime live⇄mock swaps (a snapshot must be
  // labelled by how it was ACTUALLY fetched, not the startup config).
  const effectiveNs1 = (): Ns1Config => resolveEffectiveNs1(ns1, ns1Connection);

  // Capture — fetch, preserve raw, canonicalise, checksum, persist snapshot + audit atomically.
  app.post('/ns1/zones/:zone/:domain/:type/snapshots', { preHandler: requirePermission('snapshot.create'), schema: doc('Capture an NS1 record snapshot') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const { zone, domain, type } = req.params as { zone: string; domain: string; type: string };
    const bodyLabel = (req.body as { label?: unknown } | null)?.label;
    const label = typeof bodyLabel === 'string' && bodyLabel.trim() ? bodyLabel.trim().slice(0, 200) : undefined;
    const sourceEndpoint = `/v1/zones/${zone}/${domain}/${type}`;
    const retrievedAt = new Date();

    let raw: unknown;
    try {
      raw = await client.getRecord(zone, domain, type, req.id);
    } catch (err) {
      if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
      throw err;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return sendNs1Error(req, reply, new Ns1Error('NS1_INVALID_RESPONSE'));
    }

    const principal = req.principal!;
    const eff = effectiveNs1();
    const snapshot = await captureRecordSnapshot(database, { zone, domain, type }, raw, eff.mode, {
      createdBySubject: principal.subject,
      label,
      auditActorRoles: principal.roles,
      auditAuthenticationMethod: principal.authenticationMethod,
      correlationId: req.id,
    });

    return reply.code(201).send({ provenance: buildProvenance(eff, sourceEndpoint, retrievedAt.toISOString()), snapshot: detail(snapshot) });
  });

  // History — snapshots for a record, newest first.
  app.get('/ns1/zones/:zone/:domain/:type/snapshots', { preHandler: requirePermission('snapshot.read'), schema: doc('List snapshots for a record') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const { zone, domain, type } = req.params as { zone: string; domain: string; type: string };
    const items = await database.snapshots.list({ resourceKind: 'record', resourceKey: `${zone}/${domain}/${type}`, limit: 100 });
    return { count: items.length, snapshots: items.map(summary) };
  });

  // Detail — a single snapshot (with payloads).
  app.get('/snapshots/:snapshotId', { preHandler: requirePermission('snapshot.read'), schema: doc('Get a snapshot') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const { snapshotId } = req.params as { snapshotId: string };
    if (!UUID.test(snapshotId)) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });
    const s = await database.snapshots.getById(snapshotId);
    if (!s) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });
    return { snapshot: detail(s) };
  });

  // Rename — change a snapshot's human label only. The captured payload, checksums and
  // provenance are immutable; this touches the label alone. snapshot.create (Engineer).
  app.patch('/snapshots/:snapshotId', { preHandler: requirePermission('snapshot.create'), schema: doc('Rename a snapshot') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const { snapshotId } = req.params as { snapshotId: string };
    if (!UUID.test(snapshotId)) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });
    const parsed = z.object({ label: z.string().nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Provide a label (string or null).', correlationId: req.id });
    const label = parsed.data.label && parsed.data.label.trim() ? parsed.data.label.trim().slice(0, 200) : null;
    const updated = await database.snapshots.updateLabel(snapshotId, label);
    if (!updated) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });
    const principal = req.principal!;
    await database.audit.record({
      actorSubject: principal.subject,
      actorRoles: principal.roles,
      authenticationMethod: principal.authenticationMethod,
      action: 'snapshot.relabel',
      resourceType: 'record',
      resourceKey: updated.resourceKey,
      outcome: 'success',
      correlationId: req.id,
      details: { snapshotId: updated.id, label },
    });
    return { snapshot: detail(updated) };
  });

  // Compare — structural diff of two snapshots' canonical payloads.
  app.post('/snapshots/compare', { preHandler: requirePermission('snapshot.read'), schema: doc('Compare two snapshots') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const parsed = z.object({ a: z.string(), b: z.string() }).safeParse(req.body);
    if (!parsed.success || !UUID.test(parsed.data.a) || !UUID.test(parsed.data.b)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Provide two snapshot ids (a, b).', correlationId: req.id });
    }
    const [a, b] = await Promise.all([database.snapshots.getById(parsed.data.a), database.snapshots.getById(parsed.data.b)]);
    if (!a || !b) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'One or both snapshots were not found.', correlationId: req.id });
    const diff = diffJson(a.canonicalPayload, b.canonicalPayload);
    const identical = a.structuralChecksum !== undefined && a.structuralChecksum === b.structuralChecksum;
    return { a: summary(a), b: summary(b), identical, diffCount: diff.length, diff };
  });

  // Compare a stored snapshot with the CURRENT NS1 record (fetched server-side). This is
  // a read-only comparison — no snapshot is created and NS1 is never modified.
  app.post('/snapshots/:snapshotId/compare-current', { preHandler: requirePermission('snapshot.read'), schema: doc('Compare a snapshot with a current NS1 record') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const { snapshotId } = req.params as { snapshotId: string };
    if (!UUID.test(snapshotId)) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });
    const snap = await database.snapshots.getById(snapshotId);
    if (!snap) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });

    const parts = snap.resourceKey.split('/');
    if (snap.resourceKind !== 'record' || parts.length !== 3 || parts.some((p) => p.length === 0)) {
      return reply.code(422).send({ code: 'UNSUPPORTED_RESOURCE', message: 'This snapshot cannot be compared with a current record.', correlationId: req.id });
    }
    // Target record: the snapshot's own record by default, OR an explicit {zone,domain,type} in
    // the body so a snapshot can be diffed against ANY current record in the zone (e.g. compare a
    // captured `live` config against the current `livebase`). All three must be given together.
    const targetSchema = z.object({ zone: z.string().min(1), domain: z.string().min(1), type: z.string().min(1) }).partial();
    const parsedTarget = targetSchema.safeParse(req.body ?? {});
    if (!parsedTarget.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Provide zone, domain and type together, or omit them.', correlationId: req.id });
    const t = parsedTarget.data;
    const providedKeys = [t.zone, t.domain, t.type].filter((v) => v !== undefined).length;
    if (providedKeys !== 0 && providedKeys !== 3) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Provide zone, domain and type together, or omit them.', correlationId: req.id });
    }
    const [zone, domain, type] = providedKeys === 3 ? [t.zone!, t.domain!, t.type!] : parts;
    const retrievedAt = new Date().toISOString();

    let currentRaw: unknown;
    try {
      currentRaw = await client.getRecord(zone, domain, type, req.id); // server-side fetch; request body is ignored
    } catch (err) {
      if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
      throw err;
    }
    if (!currentRaw || typeof currentRaw !== 'object' || Array.isArray(currentRaw)) {
      return sendNs1Error(req, reply, new Ns1Error('NS1_INVALID_RESPONSE'));
    }

    const currentCanonical = canonicalise(currentRaw);
    const currentRawSum = rawChecksum(currentRaw);
    const currentStructSum = structuralChecksum(currentRaw);
    const changes = diffJson(snap.canonicalPayload, currentCanonical);
    const identical = snap.structuralChecksum !== undefined && snap.structuralChecksum === currentStructSum;
    const md = snap.metadata as { mode?: string; synthetic?: boolean };

    const eff = effectiveNs1();
    const crossRecord = `${zone}/${domain}/${type}` !== snap.resourceKey;
    const warnings: string[] = [];
    if (eff.mode === 'mock') warnings.push('Current record was read in mock mode (synthetic, non-production).');
    if (md.mode && md.mode !== eff.mode) warnings.push(`Snapshot was captured in "${md.mode}" mode but the current record was read in "${eff.mode}" mode.`);
    if (crossRecord) warnings.push(`Comparing across different records: snapshot is "${snap.resourceKey}", current is "${zone}/${domain}/${type}". Differences include the record identity itself.`);

    return {
      snapshot: {
        id: snap.id,
        label: snap.label,
        resourceKey: snap.resourceKey,
        capturedAt: snap.createdAt,
        retrievedAt: snap.retrievedAt,
        sourceMode: md.mode ?? null,
        synthetic: Boolean(md.synthetic),
        rawChecksum: snap.rawChecksum,
        structuralChecksum: snap.structuralChecksum,
      },
      current: {
        resourceKey: `${zone}/${domain}/${type}`,
        retrievedAt,
        sourceMode: eff.mode,
        synthetic: eff.mode === 'mock',
        rawChecksum: currentRawSum,
        structuralChecksum: currentStructSum,
      },
      target: { zone, domain, type },
      crossRecord,
      rawChecksumEqual: snap.rawChecksum === currentRawSum,
      structuralChecksumEqual: identical,
      identical,
      summary: summariseRecordDiff(snap.canonicalPayload, currentCanonical, changes),
      changes,
      warnings,
      provenance: buildProvenance(eff, `/v1/zones/${zone}/${domain}/${type}`, retrievedAt),
    };
  });
};

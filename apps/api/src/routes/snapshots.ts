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
import { buildProvenance, sendNs1Error } from './ns1-helpers.js';

export interface SnapshotRouteOptions {
  client: Ns1ReadClient;
  ns1: Ns1Config;
  database?: Database;
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
  const { client, ns1, database } = opts;

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
    const snapshot = await captureRecordSnapshot(database, { zone, domain, type }, raw, ns1.mode, {
      createdBySubject: principal.subject,
      label,
      auditActorRoles: principal.roles,
      auditAuthenticationMethod: principal.authenticationMethod,
      correlationId: req.id,
    });

    return reply.code(201).send({ provenance: buildProvenance(ns1, sourceEndpoint, retrievedAt.toISOString()), snapshot: detail(snapshot) });
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
  app.post('/snapshots/:snapshotId/compare-current', { preHandler: requirePermission('snapshot.read'), schema: doc('Compare a snapshot with the current record') }, async (req, reply) => {
    if (!requireDb(database, req, reply)) return reply;
    const { snapshotId } = req.params as { snapshotId: string };
    if (!UUID.test(snapshotId)) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });
    const snap = await database.snapshots.getById(snapshotId);
    if (!snap) return reply.code(404).send({ code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found.', correlationId: req.id });

    const parts = snap.resourceKey.split('/');
    if (snap.resourceKind !== 'record' || parts.length !== 3 || parts.some((p) => p.length === 0)) {
      return reply.code(422).send({ code: 'UNSUPPORTED_RESOURCE', message: 'This snapshot cannot be compared with a current record.', correlationId: req.id });
    }
    const [zone, domain, type] = parts;
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

    const warnings: string[] = [];
    if (ns1.mode === 'mock') warnings.push('Current record was read in mock mode (synthetic, non-production).');
    if (md.mode && md.mode !== ns1.mode) warnings.push(`Snapshot was captured in "${md.mode}" mode but the current record was read in "${ns1.mode}" mode.`);

    return {
      snapshot: {
        id: snap.id,
        label: snap.label,
        capturedAt: snap.createdAt,
        retrievedAt: snap.retrievedAt,
        sourceMode: md.mode ?? null,
        synthetic: Boolean(md.synthetic),
        rawChecksum: snap.rawChecksum,
        structuralChecksum: snap.structuralChecksum,
      },
      current: {
        retrievedAt,
        sourceMode: ns1.mode,
        synthetic: ns1.mode === 'mock',
        rawChecksum: currentRawSum,
        structuralChecksum: currentStructSum,
      },
      rawChecksumEqual: snap.rawChecksum === currentRawSum,
      structuralChecksumEqual: identical,
      identical,
      summary: summariseRecordDiff(snap.canonicalPayload, currentCanonical, changes),
      changes,
      warnings,
      provenance: buildProvenance(ns1, `/v1/zones/${zone}/${domain}/${type}`, retrievedAt),
    };
  });
};

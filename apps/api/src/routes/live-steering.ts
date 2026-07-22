// Live Steering — read-only APIs backed by RADAR's persisted steering state and events.
// These describe the CURRENT EXPECTED DNS steering (the deterministic result of evaluating
// NS1's Filter Chain for each configured ISP scenario) — never actual delivered traffic.
// No NS1 writes, no sockets: the frontend polls /events and refreshes state on demand.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SteeringStore } from '../database/steering-store.js';
import { requirePermission } from '../auth/guards.js';
import { DEFAULT_WATCHED_RECORDS, ISP_SCENARIOS, preferredPathForAsn } from '../change-detection/isps.js';
import { REASON_DISPLAY, STEERING_REASONS, type SteeringReason } from '../change-detection/steering-state.js';
import type { CloudVisionPoller } from '../cloudvision/poller.js';
import { buildShedSignals, SHED_ISPS } from '@radar/shed';

export interface LiveSteeringRouteOptions {
  store?: SteeringStore;
  /** CloudVision poller — source of the live interface utilisation for the shed-signal view. */
  cvPoller?: CloudVisionPoller;
}

const MAX_SELECTABLE_ISPS = 6;

const stateQuerySchema = z.object({
  isp: z.string().max(120).optional(),
  asn: z.coerce.number().int().positive().max(4_294_967_295).optional(),
  record: z.string().max(400).optional(),
});

const eventsQuerySchema = z.object({
  isp: z.string().max(120).optional(),
  asn: z.coerce.number().int().positive().max(4_294_967_295).optional(),
  record: z.string().max(400).optional(),
  since: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const reasonDisplay = (reason: string): string =>
  (REASON_DISPLAY as Record<string, string>)[reason] ?? REASON_DISPLAY.unknown_structural_change;

export const liveSteeringRoutes: FastifyPluginAsync<LiveSteeringRouteOptions> = async (app, opts) => {
  const { store } = opts;

  // --- Configured scenarios (static config; no persistence required) -----------
  app.get(
    '/live-steering/config',
    {
      preHandler: requirePermission('steering.summary.read'),
      schema: {
        tags: ['live-steering'],
        summary: 'Live Steering configuration',
        description:
          'Configured ISP scenarios, watched records, requester-ASN → preferred RTÉ network path mapping and the steering-change reason vocabulary. Describes CURRENT EXPECTED DNS steering, never actual delivered traffic.',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      provenance: { source: 'radar', readOnly: true, label: 'Current Expected DNS Steering', retrievedAt: new Date().toISOString() },
      maxSelectableIsps: MAX_SELECTABLE_ISPS,
      pollIntervalsSeconds: [15, 30, 60],
      defaultPollIntervalSeconds: 30,
      highlightSeconds: 10,
      isps: ISP_SCENARIOS.map((isp) => ({ id: isp.id, name: isp.name, asn: isp.asn, ecsPrefix: isp.ecsPrefix, preferredPath: preferredPathForAsn(isp.asn) })),
      records: DEFAULT_WATCHED_RECORDS.map((r) => ({ zone: r.zone, domain: r.domain, type: r.type, resourceKey: `${r.zone}/${r.domain}/${r.type}` })),
      reasons: STEERING_REASONS.map((r: SteeringReason) => ({ id: r, label: REASON_DISPLAY[r] })),
    }),
  );

  // --- Latest persisted per-ISP steering state --------------------------------
  app.get(
    '/live-steering/state',
    {
      preHandler: requirePermission('steering.summary.read'),
      schema: {
        tags: ['live-steering'],
        summary: 'Latest expected DNS steering state per ISP',
        description:
          'The latest persisted expected-DNS-steering state for each configured ISP scenario (bounded filters: isp, asn, record). This is the deterministic evaluation of the NS1 Filter Chain — the expected probabilistic DNS distribution, never observed traffic.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      if (!store) {
        return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Live Steering persistence is not configured.', correlationId: req.id });
      }
      const parsed = stateQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');
        return reply.code(400).send({ code: 'INVALID_REQUEST', message, correlationId: req.id });
      }
      const q = parsed.data;
      const states = await store.states.list({ ispId: q.isp, asn: q.asn, resourceKey: q.record });
      return {
        provenance: { source: 'radar', readOnly: true, label: 'Current Expected DNS Steering', retrievedAt: new Date().toISOString() },
        count: states.length,
        items: states.map((s) => ({
          ispId: s.ispId,
          ispName: s.ispName,
          asn: s.asn,
          resourceKey: s.resourceKey,
          identitySource: s.identitySource,
          country: s.country,
          matchedPrefix: s.matchedPrefix,
          preferredPath: s.preferredPath,
          eligibleAnswerIds: s.eligibleAnswerIds,
          distribution: s.distribution,
          filterChain: s.filterChain,
          complete: s.complete,
          stoppedAtFilterIndex: s.stoppedAtFilterIndex,
          fingerprint: s.fingerprint,
          structuralChecksum: s.structuralChecksum,
          evaluatedAt: s.evaluatedAt,
          updatedAt: s.updatedAt,
        })),
      };
    },
  );

  // --- Meaningful steering-change events (persisted) --------------------------
  app.get(
    '/live-steering/events',
    {
      preHandler: requirePermission('steering.summary.read'),
      schema: {
        tags: ['live-steering'],
        summary: 'Meaningful expected-DNS-steering change events',
        description:
          'Persisted steering-change events (newest first) — one per meaningful expected-steering fingerprint change, with an attributed reason. Bounded filters: isp, asn, record, since, before, limit (max 500). Never invents causality: attributes "Reason not yet attributable" when a change is not clearly explainable.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      if (!store) {
        return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Live Steering persistence is not configured.', correlationId: req.id });
      }
      const parsed = eventsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');
        return reply.code(400).send({ code: 'INVALID_REQUEST', message, correlationId: req.id });
      }
      const q = parsed.data;
      const events = await store.events.list({ ispId: q.isp, asn: q.asn, resourceKey: q.record, since: q.since, before: q.before, limit: q.limit });
      return {
        provenance: { source: 'radar', readOnly: true, label: 'Current Expected DNS Steering', retrievedAt: new Date().toISOString() },
        count: events.length,
        items: events.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt,
          ispId: e.ispId,
          ispName: e.ispName,
          asn: e.asn,
          resourceKey: e.resourceKey,
          reason: e.reason,
          reasonLabel: reasonDisplay(e.reason),
          previousFingerprint: e.previousFingerprint,
          currentFingerprint: e.currentFingerprint,
          previousChecksum: e.previousChecksum,
          currentChecksum: e.currentChecksum,
          previousState: e.previousState,
          currentState: e.currentState,
          activity: e.activity,
        })),
      };
    },
  );

  // --- Shed signals: per-(ISP × datacentre) egress utilisation + the shed_load gating that WOULD be
  //     fed to NS1 (dry-run visualisation; RADAR writes nothing). Raw util from the live CloudVision
  //     snapshot; the pure gating is applied client-side so the watermarks stay adjustable. ---------
  app.get(
    '/live-steering/shed-signals',
    {
      preHandler: requirePermission('steering.summary.read'),
      schema: {
        tags: ['live-steering'],
        summary: 'Per-(ISP × DC) utilisation + NS1 shed_load gating (dry-run)',
        description:
          'The live per-ISP (incl. INEX) per-datacentre egress utilisation from CloudVision, with the default shed_load watermark policy. Models the load-shedding signals RADAR WOULD feed to NS1’s shed_load filter — READ-ONLY, nothing is sent to NS1.',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const latest = opts.cvPoller?.getLatest() ?? null;
      const source = opts.cvPoller?.status().source ?? 'disabled';
      const signals = buildShedSignals(latest?.interfaces ?? []);
      return {
        provenance: {
          source: 'radar',
          readOnly: true,
          write: false,
          telemetrySource: source, // 'cloudvision' when live; 'disabled'/'mock' otherwise
          label: 'Shed signals that would be fed to NS1 (dry-run)',
          notice: 'Dry-run visualisation of the NS1 shed_load feed. RADAR sends nothing to NS1 here.',
          observedAt: latest?.capturedAt ?? null,
          retrievedAt: new Date().toISOString(),
        },
        connected: source === 'cloudvision',
        defaultWatermarks: SHED_ISPS.map((i) => ({ id: i.id, low: i.watermark.low, high: i.watermark.high })),
        ...signals,
      };
    },
  );
};

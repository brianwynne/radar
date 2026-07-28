// Stream Assurance routes (read-only views + engineer configuration + audited diagnostic runs).
// RBAC mirrors existing RADAR roles: NOC views state/evidence (topology.summary.read), a viewing
// engineer runs diagnostics (dns.explain.read), an engineer configures profiles (connector.manage).
// No secrets or keys are returned; profile config carries no credentials.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { streamAssurance as sa } from '@radar/engine';
import type { AuditRepository, StreamAssuranceRepository } from '@radar/data';
import { requirePermission } from '../auth/guards.js';
import { StreamAssuranceService, ProfileNotFoundError } from '../stream-assurance/service.js';
import type { StreamAssuranceScheduler } from '../stream-assurance/scheduler.js';

export interface StreamAssuranceRouteOptions {
  repo?: StreamAssuranceRepository;
  service?: StreamAssuranceService;
  scheduler?: StreamAssuranceScheduler;
  audit?: Pick<AuditRepository, 'record'>;
}

const endpointSchema = z.object({
  endpointId: z.string().min(1).max(64),
  provider: z.enum(['akamai', 'fastly', 'realta', 'origin', 'custom', 'unknown']),
  role: z.enum(['reference', 'candidate']),
  publicUrl: z.string().url().max(2048),
  connectHost: z.string().min(1).max(255),
  connectPort: z.number().int().positive().max(65535).optional(),
  hostHeader: z.string().max(255).optional(),
  sni: z.string().max(255).optional(),
  managedInternal: z.boolean().optional(),
  originHost: z.string().max(255).nullable().optional(),
  identityHeaders: z.array(z.string().max(128)).max(16).optional(),
});
const profileSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/i),
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  config: z.object({
    endpoints: z.array(endpointSchema).max(24),
    authoritativeKid: z.string().max(64).nullable().optional(),
    manifests: z.object({
      dashMpdUrl: z.string().url().max(2048).optional(),
      hlsMasterUrl: z.string().url().max(2048).optional(),
      hlsMediaUrl: z.string().url().max(2048).optional(),
      mediaFragmentUrl: z.string().url().max(2048).optional(),
    }).optional(),
    tags: z.array(z.string().max(64)).max(16).optional(),
  }),
});

export const streamAssuranceRoutes: FastifyPluginAsync<StreamAssuranceRouteOptions> = async (app, opts) => {
  const schema = (summary: string) => ({ tags: ['stream-assurance'], summary, security: [{ bearerAuth: [] }] });
  const unavailable = (id: string) => ({ code: 'SERVICE_UNAVAILABLE', message: 'Stream Assurance is not configured.', correlationId: id });

  // Rule catalogue (supported validation profiles / rules).
  app.get('/stream-assurance/rules', { preHandler: requirePermission('topology.summary.read'), schema: schema('Supported Stream Assurance rules') }, async () => ({
    count: sa.listRules().length,
    rules: sa.listRules(),
  }));

  // List profiles (config summary — no secrets).
  app.get('/stream-assurance/profiles', { preHandler: requirePermission('topology.summary.read'), schema: schema('List stream profiles') }, async (req, reply) => {
    if (!opts.repo) return reply.code(503).send(unavailable(req.id));
    const profiles = await opts.repo.listProfiles();
    return {
      count: profiles.length,
      profiles: profiles.map((p) => {
        const cfg = (p.config ?? {}) as { endpoints?: unknown[]; tags?: string[] };
        return { id: p.id, name: p.name, enabled: p.enabled, tags: cfg.tags ?? [], endpointCount: (cfg.endpoints ?? []).length, updatedAt: p.updatedAt };
      }),
    };
  });

  // Full profile (config included — for the config UI).
  app.get('/stream-assurance/profiles/:id', { preHandler: requirePermission('topology.summary.read'), schema: schema('Get a stream profile') }, async (req, reply) => {
    if (!opts.repo) return reply.code(503).send(unavailable(req.id));
    const id = (req.params as { id: string }).id;
    const p = await opts.repo.getProfile(id);
    if (!p) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Profile not found.', correlationId: req.id });
    return { profile: p };
  });

  // Latest run (observations + findings).
  app.get('/stream-assurance/profiles/:id/latest', { preHandler: requirePermission('topology.summary.read'), schema: schema('Latest run for a profile') }, async (req, reply) => {
    if (!opts.repo) return reply.code(503).send(unavailable(req.id));
    const id = (req.params as { id: string }).id;
    const run = await opts.repo.latestRun(id);
    return { run };
  });

  // Create / update a profile (engineer).
  app.post('/stream-assurance/profiles', { preHandler: requirePermission('connector.manage'), schema: schema('Create or update a stream profile') }, async (req, reply) => {
    if (!opts.repo) return reply.code(503).send(unavailable(req.id));
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), correlationId: req.id });
    const p = parsed.data;
    await opts.repo.upsertProfile({ id: p.id, name: p.name, config: p.config, enabled: p.enabled ?? true });
    const principal = req.principal!;
    await opts.audit?.record({
      actorSubject: principal.subject, actorRoles: principal.roles, authenticationMethod: principal.authenticationMethod,
      action: 'stream-assurance.profile.upsert', resourceType: 'record', resourceKey: p.id, outcome: 'success',
      correlationId: req.id, details: { name: p.name, endpointCount: p.config.endpoints.length },
    });
    return reply.code(201).send({ id: p.id });
  });

  // Trigger a diagnostic run (viewing engineer) — audited.
  app.post('/stream-assurance/profiles/:id/run', { preHandler: requirePermission('dns.explain.read'), schema: schema('Run stream assurance for a profile now') }, async (req, reply) => {
    if (!opts.service) return reply.code(503).send(unavailable(req.id));
    const id = (req.params as { id: string }).id;
    const mode = z.object({ mode: z.enum(['normal', 'event', 'conformance']).optional() }).safeParse(req.query).data?.mode ?? 'normal';
    const principal = req.principal!;
    try {
      const run = await opts.service.run(id, mode);
      await opts.audit?.record({
        actorSubject: principal.subject, actorRoles: principal.roles, authenticationMethod: principal.authenticationMethod,
        action: 'stream-assurance.run', resourceType: 'record', resourceKey: id, outcome: 'success',
        correlationId: req.id, details: { runId: run.id, mode, status: run.status, findingCount: run.findingCount },
      });
      return { run };
    } catch (e) {
      if (e instanceof ProfileNotFoundError) return reply.code(404).send({ code: 'NOT_FOUND', message: e.message, correlationId: req.id });
      throw e;
    }
  });

  // Open alerts (durable lifecycle) — optionally scoped to a profile.
  app.get('/stream-assurance/alerts', { preHandler: requirePermission('topology.summary.read'), schema: schema('Open Stream Assurance alerts') }, async (req, reply) => {
    if (!opts.repo) return reply.code(503).send(unavailable(req.id));
    const profileId = z.object({ profileId: z.string().max(64).optional() }).safeParse(req.query).data?.profileId;
    const alerts = await opts.repo.listOpenAlerts(profileId);
    const eventProfiles = opts.scheduler?.eventModeProfiles() ?? [];
    return { count: alerts.length, alerts, eventModeProfiles: eventProfiles };
  });

  // Acknowledge / resolve an alert (viewing engineer) — audited.
  for (const action of ['ack', 'resolve'] as const) {
    app.post(`/stream-assurance/alerts/:id/${action}`, { preHandler: requirePermission('dns.explain.read'), schema: schema(`${action === 'ack' ? 'Acknowledge' : 'Resolve'} an alert`) }, async (req, reply) => {
      if (!opts.repo) return reply.code(503).send(unavailable(req.id));
      const id = (req.params as { id: string }).id;
      const principal = req.principal!;
      const alert = action === 'ack' ? await opts.repo.acknowledgeAlert(id, principal.subject) : await opts.repo.resolveAlert(id);
      if (!alert) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Alert not found.', correlationId: req.id });
      await opts.audit?.record({
        actorSubject: principal.subject, actorRoles: principal.roles, authenticationMethod: principal.authenticationMethod,
        action: `stream-assurance.alert.${action}`, resourceType: 'record', resourceKey: id, outcome: 'success', correlationId: req.id,
        details: { classification: alert.classification, state: alert.state },
      });
      return { alert };
    });
  }

  // Start / stop event (key-rotation) mode for a profile (viewing engineer) — audited.
  app.post('/stream-assurance/profiles/:id/event-mode', { preHandler: requirePermission('dns.explain.read'), schema: schema('Start or stop event mode') }, async (req, reply) => {
    if (!opts.scheduler || !opts.repo) return reply.code(503).send(unavailable(req.id));
    const id = (req.params as { id: string }).id;
    const parsed = z.object({ enabled: z.boolean(), durationMinutes: z.number().int().min(1).max(240).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Provide { enabled: boolean, durationMinutes?: number }.', correlationId: req.id });
    if (!(await opts.repo.getProfile(id))) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Profile not found.', correlationId: req.id });
    if (parsed.data.enabled) opts.scheduler.startEventMode(id, (parsed.data.durationMinutes ?? 30) * 60_000);
    else opts.scheduler.stopEventMode(id);
    const principal = req.principal!;
    await opts.audit?.record({
      actorSubject: principal.subject, actorRoles: principal.roles, authenticationMethod: principal.authenticationMethod,
      action: 'stream-assurance.event-mode', resourceType: 'record', resourceKey: id, outcome: 'success', correlationId: req.id,
      details: { enabled: parsed.data.enabled, durationMinutes: parsed.data.durationMinutes ?? 30 },
    });
    return { profileId: id, eventMode: parsed.data.enabled };
  });
};

// RADAR audit history (read-only). Exposes RADAR's OWN audit_events (e.g. snapshot
// captures) — distinct from the NS1 account activity log. Backed by the AuditRepository,
// bounded and parameterised. audit.read enforced server-side. Never exposes secrets,
// tokens, headers, cookies, raw NS1 payloads, SQL or stack traces; audit details are
// additionally redacted of any credential-like key as defence in depth.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Database } from '../database/repositories.js';
import { requirePermission } from '../auth/guards.js';

export interface AuditRouteOptions {
  database?: Database;
}

const SENSITIVE = /(^|_)(key|token|secret|password|passwd|authorization|auth|cookie|credential)s?($|_)/i;

function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details ?? {})) if (!SENSITIVE.test(k)) out[k] = v;
  return out;
}

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.coerce.date().optional(),
  after: z.coerce.date().optional(),
  actor: z.string().max(200).optional(),
  action: z.string().max(200).optional(),
  resourceType: z.string().max(200).optional(),
  resourceKey: z.string().max(400).optional(),
  outcome: z.string().max(100).optional(),
  correlationId: z.string().max(200).optional(),
});

export const auditRoutes: FastifyPluginAsync<AuditRouteOptions> = async (app, opts) => {
  const { database } = opts;

  app.get(
    '/audit',
    {
      preHandler: requirePermission('audit.read'),
      schema: {
        tags: ['audit'],
        summary: 'RADAR audit history',
        description:
          "RADAR's own audit trail (e.g. snapshot captures), newest first — distinct from the NS1 account activity log. Bounded, parameterised filters: limit, before, after, actor, action, resourceType, resourceKey, outcome, correlationId. Never returns secrets, tokens, headers, cookies, raw NS1 payloads, SQL or stack traces.",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      if (!database) {
        return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Audit persistence is not configured.', correlationId: req.id });
      }
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');
        return reply.code(400).send({ code: 'INVALID_REQUEST', message, correlationId: req.id });
      }
      const q = parsed.data;
      const retrievedAt = new Date().toISOString();
      const events = await database.audit.list({
        actorSubject: q.actor,
        action: q.action,
        resourceType: q.resourceType,
        resourceKey: q.resourceKey,
        outcome: q.outcome,
        correlationId: q.correlationId,
        occurredAfter: q.after,
        occurredBefore: q.before,
        limit: q.limit,
      });
      return {
        provenance: { source: 'radar', readOnly: true, retrievedAt },
        count: events.length,
        items: events.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt,
          actorSubject: e.actorSubject,
          actorRoles: e.actorRoles,
          authenticationMethod: e.authenticationMethod,
          action: e.action,
          resourceType: e.resourceType,
          resourceKey: e.resourceKey,
          outcome: e.outcome,
          correlationId: e.correlationId,
          details: redactDetails(e.details),
        })),
      };
    },
  );
};

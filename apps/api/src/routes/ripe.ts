// Read-only RIPE BGP intelligence routes. Viewable with topology.summary.read (NOC). No secrets;
// RADAR calls RIPE from the backend and serves the normalised snapshot + RIS Live event timeline.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { RipeService } from '../ripe/service.js';

export interface RipeRouteOptions {
  service?: RipeService;
}

export const ripeRoutes: FastifyPluginAsync<RipeRouteOptions> = async (app, opts) => {
  const schema = (summary: string) => ({ tags: ['bgp-intelligence'], summary, security: [{ bearerAuth: [] }] });
  const unavailable = (id: string) => ({ code: 'SERVICE_UNAVAILABLE', message: 'RIPE BGP intelligence is not configured.', correlationId: id });

  app.get('/ripe/snapshot', { preHandler: requirePermission('topology.summary.read'), schema: schema('RIPE route-visibility snapshot') }, async (req, reply) => {
    if (!opts.service) return reply.code(503).send(unavailable(req.id));
    const snapshot = opts.service.snapshot();
    return { snapshot, source: opts.service.sourceHealth() };
  });

  app.get('/ripe/events', { preHandler: requirePermission('topology.summary.read'), schema: schema('RIS Live BGP event timeline') }, async (req, reply) => {
    if (!opts.service) return reply.code(503).send(unavailable(req.id));
    const q = z.object({ prefix: z.string().max(64).optional(), kind: z.enum(['announcement', 'withdrawal']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: q.error.issues.map((i) => i.message).join('; '), correlationId: req.id });
    let items = opts.service.events();
    if (q.data.prefix) items = items.filter((e) => e.prefix === q.data.prefix);
    if (q.data.kind) items = items.filter((e) => e.kind === q.data.kind);
    items = items.slice(0, q.data.limit ?? 200);
    return { count: items.length, items };
  });
};

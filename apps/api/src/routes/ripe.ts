// Read-only RIPE BGP intelligence routes. Viewable with topology.summary.read (NOC). No secrets;
// RADAR calls RIPE from the backend and serves the normalised snapshot + RIS Live event timeline.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { RipeService } from '../ripe/service.js';
import type { RisEventRepository } from '@radar/data';

export interface RipeRouteOptions {
  service?: RipeService;
  /** Persisted RIS Live event history (drives the timeline's look-back window). */
  history?: RisEventRepository;
}

const RETENTION_DAYS = 90;
const MAX_MINUTES = RETENTION_DAYS * 24 * 60;

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

  // Persisted RIS Live event history over a look-back window (default 24h, up to the 90-day
  // retention). Sparse — RTÉ's monitored prefixes only. Also returns RIS connection-state
  // transitions so a collector gap is visible, not silently shown as "all quiet".
  app.get('/ripe/events/history', { preHandler: requirePermission('topology.summary.read'), schema: schema('RIS Live BGP event history') }, async (req, reply) => {
    if (!opts.history) return reply.code(503).send(unavailable(req.id));
    const q = z.object({
      minutes: z.coerce.number().int().min(1).max(MAX_MINUTES).optional(),
      endMs: z.coerce.number().int().nonnegative().optional(),
      prefix: z.string().max(64).optional(),
      kind: z.enum(['announcement', 'withdrawal']).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: q.error.issues.map((i) => i.message).join('; '), correlationId: req.id });

    const nowMs = Date.now();
    const minutes = q.data.minutes ?? 24 * 60;
    const endMs = Math.min(nowMs, Math.max(nowMs - RETENTION_DAYS * 86_400_000, q.data.endMs ?? nowMs));
    const startMs = endMs - minutes * 60_000;
    const since = new Date(startMs);
    const until = new Date(endMs);

    const [items, connectionChanges] = await Promise.all([
      opts.history.range({ since, until, prefix: q.data.prefix, kind: q.data.kind, limit: 500 }),
      opts.history.connectionChanges({ since, until, limit: 200 }),
    ]);
    return {
      count: items.length,
      items,
      connectionChanges,
      windowStartMs: startMs,
      windowEndMs: endMs,
      retentionDays: RETENTION_DAYS,
    };
  });
};

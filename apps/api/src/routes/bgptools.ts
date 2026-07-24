// Read-only bgp.tools routing-intelligence data + Engineer-managed watch list. The snapshot,
// incidents and prefixes are viewable with `topology.summary.read` (NOC); managing the monitored
// prefixes requires `mapping.manage` (Engineer). No secret is ever exposed here.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { BgpToolsConnectorManager } from '../bgptools/manager.js';
import type { AsnResolver } from '../ns1/asn-resolver.js';
import type { BgpToolsIncidentRepository, BgpToolsMonitoredPrefixRepository, IncidentState } from '@radar/data';

export interface BgpToolsRouteOptions {
  manager?: BgpToolsConnectorManager;
  incidents?: BgpToolsIncidentRepository;
  monitored?: BgpToolsMonitoredPrefixRepository;
  /** ASN → owner resolver (RIPEstat); ASN ownership is external, not in bgp.tools. */
  resolver?: AsnResolver;
}

const prefixSchema = z.object({
  prefix: z.string().min(1).max(64),
  addressFamily: z.enum(['ipv4', 'ipv6']),
  expectedOriginAsn: z.number().int().positive(),
  description: z.string().max(200).optional(),
});

export const bgpToolsRoutes: FastifyPluginAsync<BgpToolsRouteOptions> = async (app, opts) => {
  const schema = (summary: string) => ({ tags: ['routing-intelligence'], summary, security: [{ bearerAuth: [] }] });
  const unavailable = (id: string) => ({ code: 'CONNECTOR_UNAVAILABLE', message: 'bgp.tools connector is not configured.', correlationId: id });

  // Current routing-intelligence snapshot + connector status.
  app.get('/routing/snapshot', { preHandler: requirePermission('topology.summary.read'), schema: schema('Current routing-intelligence snapshot') }, async (req, reply) => {
    if (!opts.manager) return reply.code(503).send(unavailable(req.id));
    const poller = opts.manager.getPoller();
    return { status: poller.status(), snapshot: poller.snapshot, connection: opts.manager.connectionDiagnostic() };
  });

  // Per-prefix assessments (the visibility matrix) drawn from the latest snapshot.
  app.get('/routing/prefixes', { preHandler: requirePermission('topology.summary.read'), schema: schema('Per-prefix routing-integrity assessments') }, async (req, reply) => {
    if (!opts.manager) return reply.code(503).send(unavailable(req.id));
    const snap = opts.manager.getPoller().snapshot;
    return { count: snap?.assessments.length ?? 0, items: snap?.assessments ?? [], capturedAt: snap?.capturedAt ?? null, provenance: snap?.provenance ?? null };
  });

  // Incident feed.
  const incidentQuery = z.object({ state: z.enum(['detected', 'active', 'acknowledged', 'resolved', 'suppressed']).optional(), openOnly: z.coerce.boolean().optional(), prefix: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
  app.get('/routing/incidents', { preHandler: requirePermission('topology.summary.read'), schema: schema('Routing incidents') }, async (req, reply) => {
    if (!opts.incidents) return reply.code(503).send(unavailable(req.id));
    const q = incidentQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: q.error.issues.map((i) => i.message).join('; '), correlationId: req.id });
    const items = await opts.incidents.list({ state: q.data.state as IncidentState | undefined, openOnly: q.data.openOnly, prefix: q.data.prefix, limit: q.data.limit });
    return { count: items.length, items };
  });

  // Resolve ASN → network-owner names (origin + upstream ASNs). ASN ownership is external to
  // bgp.tools, so RADAR resolves it via RIPEstat and carries the source.
  app.get('/routing/asn-names', { preHandler: requirePermission('topology.summary.read'), schema: schema('Resolve ASN owners') }, async (req) => {
    const q = z.object({ asns: z.string().optional() }).safeParse(req.query);
    const asns = (q.success ? q.data.asns ?? '' : '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    if (!opts.resolver || asns.length === 0) return { source: opts.resolver?.source ?? 'none', owners: {} as Record<string, string | null> };
    const map = await opts.resolver.resolve(asns);
    const owners: Record<string, string | null> = {};
    for (const [asn, holder] of map) owners[String(asn)] = holder;
    return { source: opts.resolver.source, owners };
  });

  // ---- Monitored watch list ----------------------------------------------------------------

  app.get('/routing/monitored', { preHandler: requirePermission('topology.summary.read'), schema: schema('List monitored prefixes') }, async (req, reply) => {
    if (!opts.monitored) return reply.code(503).send(unavailable(req.id));
    const items = await opts.monitored.list();
    return { count: items.length, items };
  });

  app.put('/routing/monitored', { preHandler: requirePermission('mapping.manage'), schema: schema('Add or update a monitored prefix') }, async (req, reply) => {
    if (!opts.monitored) return reply.code(503).send(unavailable(req.id));
    const parsed = prefixSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '), correlationId: req.id });
    const record = await opts.monitored.upsert({ ...parsed.data, createdBy: req.principal?.subject });
    return { record };
  });

  app.delete('/routing/monitored', { preHandler: requirePermission('mapping.manage'), schema: schema('Remove a monitored prefix') }, async (req, reply) => {
    if (!opts.monitored) return reply.code(503).send(unavailable(req.id));
    const parsed = z.object({ prefix: z.string().min(1).max(64) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'prefix is required', correlationId: req.id });
    const removed = await opts.monitored.remove(parsed.data.prefix);
    if (!removed) return reply.code(404).send({ code: 'NOT_FOUND', message: 'No such monitored prefix.', correlationId: req.id });
    return { removed: true };
  });
};

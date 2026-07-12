// Read-only Réalta cache-pool / cache-node / origin telemetry routes. INFORMATIONAL only —
// RADAR never modifies NS1 or Cloudflare from telemetry. Configured capacity/node-count are
// returned separately from observed throughput/CPU. Engineering detail (thresholds,
// warnings) is gated on ns1.detail.read. Never returns source URLs, queries or credentials.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { TelemetryMode } from '../telemetry/index.js';
import type { CacheNodeSample, CacheTelemetryClient, CachePoolSample, OriginSample } from '../telemetry/cache-types.js';

export interface CacheTelemetryRouteOptions {
  client?: CacheTelemetryClient;
  mode?: TelemetryMode;
}

const INFORMATIONAL_NOTICE = 'Cache and origin telemetry are informational. RADAR is not automatically modifying NS1 or Cloudflare.';

const poolQuerySchema = z.object({
  site: z.string().max(120).optional(),
  status: z.enum(['healthy', 'above_target', 'warning', 'critical', 'unavailable', 'stale', 'telemetry_not_connected']).optional(),
  stale: z.enum(['true', 'false']).optional(),
});
const nodeQuerySchema = poolQuerySchema.extend({ poolId: z.string().max(120).optional() });

function presentPool(s: CachePoolSample, detail: boolean): Record<string, unknown> {
  const core = {
    poolId: s.poolId, poolName: s.poolName, site: s.site, cacheNodeCount: s.cacheNodeCount,
    configuredCapacityBps: s.configuredCapacityBps, observedOutboundBps: s.observedOutboundBps,
    observedUtilisationPercent: s.observedUtilisationPercent, headroomBps: s.headroomBps,
    cpuUtilisationPercent: s.cpuUtilisationPercent, memoryUtilisationPercent: s.memoryUtilisationPercent,
    cacheHitRatio: s.cacheHitRatio, requestRate: s.requestRate,
    status: s.status, stale: s.stale, freshness: s.freshness, observedAt: s.observedAt, source: s.source, provenance: s.provenance,
  };
  return detail ? { ...core, targetPercent: s.targetPercent, warningPercent: s.warningPercent, criticalPercent: s.criticalPercent, warnings: s.warnings } : core;
}

function presentNode(s: CacheNodeSample, detail: boolean): Record<string, unknown> {
  const core = {
    nodeId: s.nodeId, nodeName: s.nodeName, poolId: s.poolId, site: s.site,
    configuredCapacityBps: s.configuredCapacityBps, observedOutboundBps: s.observedOutboundBps,
    observedUtilisationPercent: s.observedUtilisationPercent, headroomBps: s.headroomBps,
    cpuUtilisationPercent: s.cpuUtilisationPercent, memoryUtilisationPercent: s.memoryUtilisationPercent,
    cacheHitRatio: s.cacheHitRatio, requestRate: s.requestRate,
    status: s.status, stale: s.stale, freshness: s.freshness, observedAt: s.observedAt, source: s.source, provenance: s.provenance,
  };
  return detail ? { ...core, targetPercent: s.targetPercent, warningPercent: s.warningPercent, criticalPercent: s.criticalPercent, warnings: s.warnings } : core;
}

function presentOrigin(s: OriginSample, detail: boolean): Record<string, unknown> {
  const core = {
    originId: s.originId, originName: s.originName, requestRate: s.requestRate, outboundBandwidthBps: s.outboundBandwidthBps,
    cpuUtilisationPercent: s.cpuUtilisationPercent, status: s.status, stale: s.stale, freshness: s.freshness,
    observedAt: s.observedAt, source: s.source, provenance: s.provenance,
  };
  return detail ? { ...core, warnings: s.warnings } : core;
}

const badRequest = (issues: z.ZodError['issues']) => issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');

export const cacheTelemetryRoutes: FastifyPluginAsync<CacheTelemetryRouteOptions> = async (app, opts) => {
  const mode: TelemetryMode = opts.mode ?? 'disabled';
  const envelope = (retrievedAt: string) => ({ source: 'radar' as const, telemetryMode: mode, readOnly: true, informationalOnly: true, notice: INFORMATIONAL_NOTICE, retrievedAt });
  const schema = (summary: string, description: string) => ({ tags: ['telemetry'], summary, description, security: [{ bearerAuth: [] }] });

  app.get(
    '/telemetry/cache-pools',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Réalta cache-pool telemetry', 'Read-only, informational per-pool utilisation/health with configured capacity and deterministic headroom. Filters: site, status, stale. Never modifies NS1/Cloudflare; never returns source URLs, queries or credentials.') },
    async (req, reply) => {
      const parsed = poolQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: badRequest(parsed.error.issues), correlationId: req.id });
      const q = parsed.data;
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      let items = opts.client ? await opts.client.getCachePools(req.id) : [];
      if (q.site) items = items.filter((s) => s.site === q.site);
      if (q.status) items = items.filter((s) => s.status === q.status);
      if (q.stale !== undefined) items = items.filter((s) => s.stale === (q.stale === 'true'));
      return { provenance: envelope(new Date().toISOString()), count: items.length, items: items.map((s) => presentPool(s, detail)) };
    },
  );

  app.get(
    '/telemetry/cache-pools/:poolId',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Réalta cache-pool telemetry (one pool)', 'Read-only, informational telemetry for a single cache pool. 404 if unknown.') },
    async (req, reply) => {
      const { poolId } = req.params as { poolId: string };
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      const sample = opts.client ? await opts.client.getCachePool(poolId, req.id) : null;
      if (!sample) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown cache pool.', correlationId: req.id });
      return { provenance: envelope(new Date().toISOString()), item: presentPool(sample, detail) };
    },
  );

  app.get(
    '/telemetry/cache-nodes',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Réalta cache-node telemetry', 'Read-only, informational per-node utilisation/health. Filters: site, poolId, status, stale.') },
    async (req, reply) => {
      const parsed = nodeQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: badRequest(parsed.error.issues), correlationId: req.id });
      const q = parsed.data;
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      let items = opts.client ? await opts.client.getCacheNodes(req.id) : [];
      if (q.site) items = items.filter((s) => s.site === q.site);
      if (q.poolId) items = items.filter((s) => s.poolId === q.poolId);
      if (q.status) items = items.filter((s) => s.status === q.status);
      if (q.stale !== undefined) items = items.filter((s) => s.stale === (q.stale === 'true'));
      return { provenance: envelope(new Date().toISOString()), count: items.length, items: items.map((s) => presentNode(s, detail)) };
    },
  );

  app.get(
    '/telemetry/cache-nodes/:nodeId',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Réalta cache-node telemetry (one node)', 'Read-only, informational telemetry for a single cache node. 404 if unknown.') },
    async (req, reply) => {
      const { nodeId } = req.params as { nodeId: string };
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      const sample = opts.client ? await opts.client.getCacheNode(nodeId, req.id) : null;
      if (!sample) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown cache node.', correlationId: req.id });
      return { provenance: envelope(new Date().toISOString()), item: presentNode(sample, detail) };
    },
  );

  app.get(
    '/telemetry/origin',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Réalta origin telemetry', 'Read-only, informational origin request-rate / bandwidth / CPU and health.') },
    async (req, reply) => {
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      const sample = opts.client ? await opts.client.getOrigin(req.id) : null;
      if (!sample) return reply.code(503).send({ code: 'TELEMETRY_UNAVAILABLE', message: 'Origin telemetry is not configured.', correlationId: req.id });
      return { provenance: envelope(new Date().toISOString()), item: presentOrigin(sample, detail) };
    },
  );
};

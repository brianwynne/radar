// Read-only network-path telemetry routes (PNI / INEX / transit). INFORMATIONAL only —
// RADAR never modifies NS1 steering from telemetry. Configured capacity/target are returned
// separately from observed utilisation. Never returns the source URL, query, credentials or
// auth headers. NOC sees status/utilisation/capacity/freshness; Viewing Engineers (and
// above, via ns1.detail.read) additionally see the interface mapping, thresholds and
// warnings.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { TelemetryMode } from '../telemetry/index.js';
import type { NetworkPathSample, NetworkPathTelemetryClient } from '../telemetry/types.js';

export interface TelemetryRouteOptions {
  client?: NetworkPathTelemetryClient;
  mode?: TelemetryMode;
}

const INFORMATIONAL_NOTICE = 'Network telemetry is currently informational. RADAR is not automatically modifying NS1 steering.';

const listQuerySchema = z.object({
  pathType: z.enum(['PNI', 'INEX', 'transit']).optional(),
  status: z.enum(['healthy', 'above_target', 'warning', 'critical', 'unavailable', 'stale', 'telemetry_not_connected']).optional(),
  stale: z.enum(['true', 'false']).optional(),
});

/** Shape a sample for the response, gating the richer engineering detail behind
 *  `ns1.detail.read`. Never includes source URLs, queries or credentials (samples never
 *  carry them). */
function present(s: NetworkPathSample, detail: boolean): Record<string, unknown> {
  const core = {
    pathId: s.pathId,
    pathName: s.pathName,
    pathType: s.pathType,
    status: s.status,
    stale: s.stale,
    freshness: s.freshness,
    configuredCapacityBps: s.configuredCapacityBps,
    configuredTargetPercent: s.configuredTargetPercent,
    observedInboundBps: s.observedInboundBps,
    observedOutboundBps: s.observedOutboundBps,
    observedUtilisationPercent: s.observedUtilisationPercent,
    observedAt: s.observedAt,
    source: s.source,
    provenance: s.provenance,
  };
  if (!detail) return core;
  return {
    ...core,
    interfaceIdentity: s.interfaceIdentity,
    direction: s.direction,
    warningThresholdPercent: s.warningThresholdPercent,
    criticalThresholdPercent: s.criticalThresholdPercent,
    warnings: s.warnings,
  };
}

export const telemetryRoutes: FastifyPluginAsync<TelemetryRouteOptions> = async (app, opts) => {
  const mode: TelemetryMode = opts.mode ?? 'disabled';
  const envelope = (retrievedAt: string) => ({ source: 'radar' as const, telemetryMode: mode, readOnly: true, informationalOnly: true, notice: INFORMATIONAL_NOTICE, retrievedAt });

  app.get(
    '/telemetry/network-paths',
    {
      preHandler: requirePermission('topology.summary.read'),
      schema: {
        tags: ['telemetry'],
        summary: 'Network-path utilisation (PNI / INEX / transit)',
        description:
          'Read-only, informational utilisation for the configured PNI/INEX/transit paths. Configured capacity/target are returned separately from observed utilisation. Bounded filters: pathType, status, stale. Never modifies NS1 steering; never returns source URLs, queries or credentials.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');
        return reply.code(400).send({ code: 'INVALID_REQUEST', message, correlationId: req.id });
      }
      const q = parsed.data;
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      let items = opts.client ? await opts.client.getNetworkPaths(req.id) : [];
      if (q.pathType) items = items.filter((s) => s.pathType === q.pathType);
      if (q.status) items = items.filter((s) => s.status === q.status);
      if (q.stale !== undefined) items = items.filter((s) => s.stale === (q.stale === 'true'));
      return { provenance: envelope(new Date().toISOString()), count: items.length, items: items.map((s) => present(s, detail)) };
    },
  );

  app.get(
    '/telemetry/network-paths/:pathId',
    {
      preHandler: requirePermission('topology.summary.read'),
      schema: {
        tags: ['telemetry'],
        summary: 'Network-path utilisation for one path',
        description: 'Read-only, informational utilisation for a single configured path. 404 if the path id is unknown.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { pathId } = req.params as { pathId: string };
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      const sample = opts.client ? await opts.client.getNetworkPath(pathId, req.id) : null;
      if (!sample) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown network path.', correlationId: req.id });
      return { provenance: envelope(new Date().toISOString()), item: present(sample, detail) };
    },
  );
};

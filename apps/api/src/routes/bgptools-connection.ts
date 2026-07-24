// Engineer-managed bgp.tools connection settings. All routes require `connector.manage`. The
// Prometheus monitoring URL is WRITE-ONLY: accepted on update, NEVER returned, logged or echoed.
// GET exposes only whether a URL is configured + its host/metadata. Transport + validation only;
// the manager performs encryption, persistence, auditing and the runtime rebuild.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import { BgpToolsManagerError, type BgpToolsConnectorManager } from '../bgptools/manager.js';

export interface BgpToolsConnectionRouteOptions {
  manager?: BgpToolsConnectorManager;
}

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['mock', 'live']).optional(),
    tableEnabled: z.boolean().optional(),
    userAgent: z.string().max(500).optional(),
    // Write-only: omitted/blank retains, non-empty replaces. Never returned.
    prometheusUrl: z.string().max(4000).optional(),
    clearPrometheusUrl: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.clearPrometheusUrl && b.prometheusUrl !== undefined && b.prometheusUrl.trim().length > 0), {
    message: 'Provide either a new prometheusUrl or clearPrometheusUrl, not both.',
  });

const ERROR_STATUS: Record<BgpToolsManagerError['code'], number> = {
  MASTER_KEY_UNAVAILABLE: 409,
  INVALID_URL: 400,
  NO_REPOSITORY: 503,
};

export const bgpToolsConnectionRoutes: FastifyPluginAsync<BgpToolsConnectionRouteOptions> = async (app, opts) => {
  const schema = (summary: string, description: string) => ({ tags: ['routing-intelligence'], summary, description, security: [{ bearerAuth: [] }] });
  const unavailable = (correlationId: string) => ({ code: 'CONNECTOR_UNAVAILABLE', message: 'bgp.tools connector management is not configured.', correlationId });

  app.get(
    '/routing/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Get bgp.tools connection settings', 'Engineer-only. Returns settings WITHOUT the Prometheus URL (only host + configured flag + metadata).') },
    async (req, reply) => {
      if (!opts.manager) return reply.code(503).send(unavailable(req.id));
      return { settings: opts.manager.view() };
    },
  );

  app.put(
    '/routing/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Update bgp.tools connection settings', 'Engineer-only. The Prometheus URL is write-only: blank/omitted retains it, a non-empty value replaces it, clearPrometheusUrl removes it. Never returned.') },
    async (req, reply) => {
      if (!opts.manager) return reply.code(503).send(unavailable(req.id));
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '), correlationId: req.id });
      }
      try {
        const settings = await opts.manager.updateSettings(parsed.data, { subject: req.principal!.subject, roles: req.principal!.roles, correlationId: req.id });
        return { settings };
      } catch (err) {
        if (err instanceof BgpToolsManagerError) return reply.code(ERROR_STATUS[err.code]).send({ code: err.code, message: err.message, correlationId: req.id });
        throw err;
      }
    },
  );

  app.post(
    '/routing/connection/test',
    { preHandler: requirePermission('connector.manage'), schema: schema('Test the bgp.tools connection', 'Engineer-only. Pings the currently-saved connection read-only and reports pass/fail. Never persists; never returns the URL.') },
    async (req, reply) => {
      if (!opts.manager) return reply.code(503).send(unavailable(req.id));
      return { result: await opts.manager.test() };
    },
  );
};

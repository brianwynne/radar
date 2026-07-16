// Engineer-managed Cloudflare connection settings (account id + zones + API token). All routes
// require `connector.manage` (Engineer). The token is WRITE-ONLY: accepted on update but NEVER
// returned, logged or echoed. GET exposes only whether a token is configured and its metadata.
// The manager performs encryption, persistence, auditing and the runtime reconfigure; this layer
// is transport + validation only.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import { ConnectorManagerError } from '../cloudvision/manager.js';
import type { CloudflareConnectorManager } from '../cloudflare/manager.js';

export interface CloudflareConnectionRouteOptions {
  manager?: CloudflareConnectorManager;
}

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['mock', 'live']).optional(),
    accountId: z.string().max(200).nullable().optional(),
    zones: z.array(z.string().max(253)).max(200).nullable().optional(),
    // Write-only: omitted/blank retains, non-empty replaces. Never returned.
    token: z.string().max(8000).optional(),
    clearToken: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.clearToken && b.token !== undefined && b.token.trim().length > 0), {
    message: 'Provide either a new token or clearToken, not both.',
  });

const ERROR_STATUS: Record<ConnectorManagerError['code'], number> = {
  MASTER_KEY_UNAVAILABLE: 409,
  ENDPOINT_REQUIRED: 400,
  TOKEN_REQUIRED: 400,
  ENDPOINT_INSECURE: 400,
  INVALID_TOKEN_VALUE: 400,
};

export const cloudflareConnectionRoutes: FastifyPluginAsync<CloudflareConnectionRouteOptions> = async (app, opts) => {
  const schema = (summary: string, description: string) => ({ tags: ['cloudflare'], summary, description, security: [{ bearerAuth: [] }] });
  const unavailable = (correlationId: string) => ({ code: 'CONNECTOR_UNAVAILABLE', message: 'Connector management is not configured.', correlationId });

  app.get(
    '/network/cloudflare/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Get Cloudflare connection settings', 'Engineer-only. Returns the connection settings WITHOUT the token (only tokenConfigured/tokenSetAt/updatedBy).') },
    async (req, reply) => {
      if (!opts.manager) return reply.code(503).send(unavailable(req.id));
      return { settings: opts.manager.getSettingsView() };
    },
  );

  app.put(
    '/network/cloudflare/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Update Cloudflare connection settings', 'Engineer-only. Token is write-only: omitted/blank retains the stored token, a non-empty value replaces it, clearToken removes it. The token is never returned.') },
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
        if (err instanceof ConnectorManagerError) {
          return reply.code(ERROR_STATUS[err.code]).send({ code: err.code, message: err.message, correlationId: req.id });
        }
        throw err;
      }
    },
  );

  app.post(
    '/network/cloudflare/connection/test',
    { preHandler: requirePermission('connector.manage'), schema: schema('Test the Cloudflare connection', 'Engineer-only. Performs one read-only snapshot against the currently-saved connection and reports pass/fail. Never persists; never returns the token.') },
    async (req, reply) => {
      if (!opts.manager) return reply.code(503).send(unavailable(req.id));
      const result = await opts.manager.test(req.id);
      return { result };
    },
  );
};

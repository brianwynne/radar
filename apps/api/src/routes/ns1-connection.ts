// Engineer-managed NS1 connection settings (mode + API base + read-only API key). All routes
// require `connector.manage`. The key is WRITE-ONLY: accepted on update, never returned, logged or
// echoed. GET exposes only whether a key is configured plus metadata. The manager does encryption,
// persistence, auditing and the runtime client swap; this layer is transport + validation. RADAR is
// READ-ONLY to NS1 — the key should be a read-only NS1 key.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import { ConnectorManagerError } from '../cloudvision/manager.js';
import type { Ns1ConnectorManager } from '../ns1/manager.js';

export interface Ns1ConnectionRouteOptions { manager?: Ns1ConnectorManager }

const updateSchema = z
  .object({
    mode: z.enum(['mock', 'live']).optional(),
    apiBase: z.string().max(500).nullable().optional(),
    key: z.string().max(8000).optional(),
    clearKey: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.clearKey && b.key !== undefined && b.key.trim().length > 0), { message: 'Provide either a new key or clearKey, not both.' });

const ERROR_STATUS: Record<ConnectorManagerError['code'], number> = {
  MASTER_KEY_UNAVAILABLE: 409, ENDPOINT_REQUIRED: 400, TOKEN_REQUIRED: 400, ENDPOINT_INSECURE: 400, INVALID_TOKEN_VALUE: 400,
};

export const ns1ConnectionRoutes: FastifyPluginAsync<Ns1ConnectionRouteOptions> = async (app, opts) => {
  const schema = (summary: string, description: string) => ({ tags: ['ns1'], summary, description, security: [{ bearerAuth: [] }] });
  const unavailable = (correlationId: string) => ({ code: 'CONNECTOR_UNAVAILABLE', message: 'Connector management is not configured.', correlationId });

  app.get(
    '/ns1/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Get NS1 connection settings', 'Engineer-only. Returns mode + API base WITHOUT the key (only keyConfigured/keySetAt/updatedBy).') },
    async (req, reply) => { if (!opts.manager) return reply.code(503).send(unavailable(req.id)); return { settings: opts.manager.getSettingsView() }; },
  );

  app.put(
    '/ns1/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Update NS1 connection settings', 'Engineer-only. The read-only NS1 key is write-only: omitted/blank retains, non-empty replaces, clearKey removes. Live mode requires a key + HTTPS base. Never returned.') },
    async (req, reply) => {
      if (!opts.manager) return reply.code(503).send(unavailable(req.id));
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '), correlationId: req.id });
      try {
        const settings = await opts.manager.updateSettings(parsed.data, { subject: req.principal!.subject, roles: req.principal!.roles, correlationId: req.id });
        return { settings };
      } catch (err) {
        if (err instanceof ConnectorManagerError) return reply.code(ERROR_STATUS[err.code]).send({ code: err.code, message: err.message, correlationId: req.id });
        throw err;
      }
    },
  );

  app.post(
    '/ns1/connection/test',
    { preHandler: requirePermission('connector.manage'), schema: schema('Test the NS1 connection', 'Engineer-only. Lists zones read-only against the saved connection and reports the count. Never persists; never returns the key.') },
    async (req, reply) => { if (!opts.manager) return reply.code(503).send(unavailable(req.id)); return { result: await opts.manager.test(req.id) }; },
  );
};

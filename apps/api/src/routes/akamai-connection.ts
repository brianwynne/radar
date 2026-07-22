// Engineer-managed Akamai (DataStream 2 → S3) connection settings. All routes require
// `connector.manage`. The S3 secret access key is WRITE-ONLY: accepted on update, never returned,
// logged or echoed. GET exposes only whether a secret is configured plus metadata. The manager does
// encryption, persistence, auditing and the runtime reconfigure; this layer is transport + validation.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import { ConnectorManagerError } from '../cloudvision/manager.js';
import type { AkamaiConnectorManager } from '../akamai/manager.js';

export interface AkamaiConnectionRouteOptions { manager?: AkamaiConnectorManager }

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    cpCodes: z.array(z.string().max(64)).max(500).nullable().optional(),
    cpNames: z.record(z.string().max(64), z.string().max(128)).nullable().optional(),
    // Charset-guarded: bucket/region are interpolated into the S3 host `${bucket}.s3.${region}.amazonaws.com`,
    // so forbid anything (/, @, :, whitespace) that could shift the effective host off amazonaws.com.
    bucket: z.string().max(63).regex(/^[a-z0-9.-]*$/, 'S3 bucket may contain only lowercase letters, digits, dots and hyphens.').nullable().optional(),
    region: z.string().max(32).regex(/^[a-z0-9-]*$/, 'S3 region may contain only lowercase letters, digits and hyphens.').nullable().optional(),
    prefix: z.string().max(512).nullable().optional(),
    accessKeyId: z.string().max(128).nullable().optional(),
    pollIntervalSeconds: z.number().int().min(5).max(3600).nullable().optional(),
    windowSeconds: z.number().int().min(30).max(3600).nullable().optional(),
    secretKey: z.string().max(8000).optional(),
    clearSecret: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.clearSecret && b.secretKey !== undefined && b.secretKey.trim().length > 0), { message: 'Provide either a new secret or clearSecret, not both.' });

const ERROR_STATUS: Record<ConnectorManagerError['code'], number> = {
  MASTER_KEY_UNAVAILABLE: 409, ENDPOINT_REQUIRED: 400, TOKEN_REQUIRED: 400, ENDPOINT_INSECURE: 400, INVALID_TOKEN_VALUE: 400,
};

export const akamaiConnectionRoutes: FastifyPluginAsync<AkamaiConnectionRouteOptions> = async (app, opts) => {
  const schema = (summary: string, description: string) => ({ tags: ['akamai'], summary, description, security: [{ bearerAuth: [] }] });
  const unavailable = (correlationId: string) => ({ code: 'CONNECTOR_UNAVAILABLE', message: 'Connector management is not configured.', correlationId });

  app.get(
    '/cdn/akamai/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Get Akamai connection settings', 'Engineer-only. Returns the settings WITHOUT the S3 secret (only secretConfigured/secretSetAt/updatedBy).') },
    async (req, reply) => { if (!opts.manager) return reply.code(503).send(unavailable(req.id)); return { settings: opts.manager.getSettingsView() }; },
  );

  app.put(
    '/cdn/akamai/connection',
    { preHandler: requirePermission('connector.manage'), schema: schema('Update Akamai connection settings', 'Engineer-only. The S3 secret is write-only: omitted/blank retains, non-empty replaces, clearSecret removes. Never returned.') },
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
    '/cdn/akamai/connection/test',
    { preHandler: requirePermission('connector.manage'), schema: schema('Test the Akamai S3 connection', 'Engineer-only. One read-only S3 list against the saved credentials. Never persists; never returns the secret.') },
    async (req, reply) => { if (!opts.manager) return reply.code(503).send(unavailable(req.id)); return { result: await opts.manager.test() }; },
  );
};

import type { FastifyPluginAsync } from 'fastify';
import { requireAuthentication } from '../auth/guards.js';

const errorSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    correlationId: { type: 'string' },
  },
} as const;

const meSchema = {
  tags: ['identity'],
  summary: 'Current principal',
  description: 'Returns the authenticated caller’s identity, roles and effective permissions. Never returns credentials or tokens.',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      required: ['subject', 'roles', 'permissions', 'authenticationMethod', 'developmentAuthentication'],
      properties: {
        subject: { type: 'string' },
        displayName: { type: 'string' },
        email: { type: 'string' },
        roles: { type: 'array', items: { type: 'string' } },
        permissions: { type: 'array', items: { type: 'string' } },
        authenticationMethod: { type: 'string', enum: ['dev', 'oidc'] },
        developmentAuthentication: { type: 'boolean' },
      },
    },
    401: errorSchema,
  },
} as const;

/** GET /api/v1/me — accessible to any authenticated principal. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: requireAuthentication, schema: meSchema }, async (req) => {
    // requireAuthentication guarantees a principal here.
    const p = req.principal!;
    return {
      subject: p.subject,
      displayName: p.displayName,
      email: p.email,
      roles: p.roles,
      permissions: p.permissions,
      authenticationMethod: p.authenticationMethod,
      developmentAuthentication: p.authenticationMethod === 'dev',
    };
  });
};

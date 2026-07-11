import type { FastifyPluginAsync } from 'fastify';
import type { AuthMode } from '../config.js';

interface HealthOptions {
  authMode: AuthMode;
}

const liveSchema = {
  tags: ['health'],
  summary: 'Liveness',
  description: 'The process is up and serving requests.',
  response: {
    200: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['live'] } },
    },
  },
} as const;

const readySchema = {
  tags: ['health'],
  summary: 'Readiness',
  description: 'The API started and its configuration loaded successfully.',
  response: {
    200: {
      type: 'object',
      required: ['status', 'checks'],
      properties: {
        status: { type: 'string', enum: ['ready'] },
        checks: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
} as const;

/** Liveness and readiness (mounted under /api/v1/health). Readiness confirms the API
 *  started and configuration loaded, and reports the active authentication mode
 *  ('development' | 'oidc' | 'unconfigured'). Downstream checks (database, NS1) are
 *  added when those subsystems land. */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const auth = opts.authMode === 'dev' ? 'development' : opts.authMode === 'oidc' ? 'oidc' : 'unconfigured';
  app.get('/live', { schema: liveSchema }, async () => ({ status: 'live' }));
  app.get('/ready', { schema: readySchema }, async () => ({ status: 'ready', checks: { config: 'ok', auth } }));
};

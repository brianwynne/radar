import type { FastifyPluginAsync } from 'fastify';
import type { AuthMode } from '../config.js';
import type { DatabaseHealthCheck } from '../database/health.js';

interface HealthOptions {
  authMode: AuthMode;
  /** Readiness probe for the database. When omitted, readiness reports `not_wired` and
   *  returns 503 (NOT ready) — a deployment must never report ready while PostgreSQL is
   *  unwired. In production, server.ts always wires this (DATABASE_URL is required to
   *  start); `not_wired` only arises in unit tests that build the app without a database. */
  databaseHealth?: DatabaseHealthCheck;
}

const liveSchema = {
  tags: ['health'],
  summary: 'Liveness',
  description: 'The process is up and serving requests. Independent of the database.',
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
  description:
    'The API started, configuration loaded, and dependencies (database) are reachable. Returns 503 when a dependency is unavailable.',
  response: {
    200: {
      type: 'object',
      required: ['status', 'checks'],
      properties: {
        status: { type: 'string', enum: ['ready'] },
        checks: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    503: {
      type: 'object',
      required: ['status', 'checks'],
      properties: {
        status: { type: 'string', enum: ['not_ready'] },
        checks: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
} as const;

/** Liveness and readiness (mounted under /api/v1/health). Liveness reflects only that the
 *  process is up. Readiness confirms configuration loaded, reports the active
 *  authentication mode ('development' | 'oidc' | 'unconfigured'), and — when wired —
 *  probes the database, returning 503 if it is unavailable. */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const auth = opts.authMode === 'dev' ? 'development' : opts.authMode === 'oidc' ? 'oidc' : 'unconfigured';

  app.get('/live', { schema: liveSchema }, async () => ({ status: 'live' }));

  app.get('/ready', { schema: readySchema }, async (_req, reply) => {
    const checks: Record<string, string> = { config: 'ok', auth };
    if (!opts.databaseHealth) {
      // Unwired database is never production-ready.
      checks.database = 'not_wired';
      return reply.code(503).send({ status: 'not_ready', checks });
    }
    const db = await opts.databaseHealth();
    // Only the coarse status is exposed — never a connection string or SQL error.
    checks.database = db.status === 'ok' ? 'ok' : 'unavailable';
    if (db.status !== 'ok') {
      return reply.code(503).send({ status: 'not_ready', checks });
    }
    return { status: 'ready', checks };
  });
};

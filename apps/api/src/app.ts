// radar-api application factory. Builds a configured Fastify instance with structured
// logging, correlation IDs, secure headers, request-size limits and OpenAPI. It wires
// no business or NS1 logic (that arrives in later commits) and holds no durable state.
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { registerAuth, type AuthDeps } from './auth/plugin.js';
import { createOidcVerifier, resolveJwks } from './auth/oidc.js';
import type { DatabaseHealthCheck } from './database/health.js';

const CORRELATION_HEADER = 'x-correlation-id';

/** Injectable dependencies for the app factory. Everything is optional so tests can wire
 *  fakes (a local JWKS, a stub database probe) without external services. */
export interface BuildDeps extends AuthDeps {
  databaseHealth?: DatabaseHealthCheck;
}

export async function buildApp(config: Config, deps: BuildDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: config.MAX_BODY_BYTES,
    trustProxy: true,
    // Reuse a supplied correlation id, else generate one. This becomes req.id, is
    // attached to every log line, and is echoed on every response.
    genReqId(req) {
      const h = req.headers[CORRELATION_HEADER];
      const supplied = Array.isArray(h) ? h[0] : h;
      return supplied && supplied.length > 0 && supplied.length <= 200 ? supplied : randomUUID();
    },
    logger: {
      level: config.LOG_LEVEL,
      // Never log secrets or credentials.
      redact: ['req.headers.authorization', 'req.headers["x-nsone-key"]', 'req.headers.cookie'],
    },
  });

  // Reject oversized requests early (defence-in-depth alongside Fastify's bodyLimit,
  // which covers chunked bodies with no Content-Length).
  app.addHook('onRequest', async (req, reply) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(len) && len > config.MAX_BODY_BYTES) {
      await reply.code(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured limit.',
        correlationId: req.id,
      });
    }
  });

  // Echo the correlation id on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header(CORRELATION_HEADER, req.id);
  });

  // Authentication: attaches request.principal per the configured mode. In OIDC mode,
  // resolve the JWKS key source (discovery or explicit override) unless a verifier was
  // injected (tests inject a local key set so Microsoft is never contacted).
  let authDeps = deps;
  if (config.authMode === 'oidc' && !deps.oidcVerifier && config.oidc) {
    const getKey = await resolveJwks(config.oidc);
    authDeps = { ...deps, oidcVerifier: createOidcVerifier(config.oidc, getKey) };
  }
  registerAuth(app, config, authDeps);

  // Consistent, safe error responses carrying the correlation id; internal detail hidden.
  app.setErrorHandler((err, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err, route: req.url }, 'unhandled request error');
    void reply.code(status).send({
      code: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status >= 500 ? 'Internal server error.' : err.message,
      correlationId: req.id,
    });
  });

  // Secure HTTP headers. CSP is disabled here because the API returns JSON and the
  // dev-only Swagger UI needs inline assets; all other helmet protections apply.
  await app.register(helmet, { contentSecurityPolicy: false });

  // OpenAPI. The document is generated from route schemas.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'RADAR API',
        version: '0.1.0',
        description:
          'RADAR — Réalta Adaptive Delivery Analysis and Routing. RTÉ NS1 steering explainability (read-only v1).',
      },
      tags: [
        { name: 'health', description: 'Liveness and readiness' },
        { name: 'identity', description: 'Authenticated principal' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'OIDC access token (Microsoft Entra ID in production).',
          },
        },
      },
    },
  });

  // Swagger UI is exposed only in development.
  if (config.NODE_ENV === 'development') {
    await app.register(swaggerUi, { routePrefix: '/api/v1/docs' });
  }

  await app.register(healthRoutes, {
    prefix: '/api/v1/health',
    authMode: config.authMode,
    databaseHealth: deps.databaseHealth,
  });
  await app.register(meRoutes, { prefix: '/api/v1' });

  // Machine-readable spec, available in all environments; hidden from the spec itself.
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}

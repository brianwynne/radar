import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { buildPrincipal, type RadarPrincipal } from './principal.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: RadarPrincipal | null;
  }
}

/** Wire request.principal. In development-authentication mode a single configured
 *  principal is attached to every request; request headers, query strings and cookies
 *  are NEVER trusted. When dev-auth is off, principal stays null (fail closed) until
 *  OIDC lands in the next commit. */
export function registerAuth(app: FastifyInstance, config: Config): void {
  const devPrincipal: RadarPrincipal | null = config.devAuth
    ? buildPrincipal({
        subject: config.devUser.id,
        displayName: config.devUser.name,
        email: config.devUser.email,
        roles: [config.devUser.role],
        authenticationMethod: 'dev',
      })
    : null;

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.principal = devPrincipal;
  });

  if (config.devAuth) {
    app.log.warn(
      { subject: config.devUser.id, role: config.devUser.role },
      'Development Authentication is ENABLED — a fixed dev principal is used for every request. Never enable in production.',
    );
  }
}

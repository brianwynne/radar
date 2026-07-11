import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { buildPrincipal, type RadarPrincipal } from './principal.js';
import type { OidcVerifier } from './oidc.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: RadarPrincipal | null;
  }
}

export interface AuthDeps {
  /** OIDC verifier (built by the app, or injected by tests). Required in OIDC mode. */
  oidcVerifier?: OidcVerifier;
}

function bearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer[ ]+(.+)$/i.exec(value.trim()) : null;
  return match ? match[1].trim() : undefined;
}

/** Wire request.principal according to the single, explicit authentication mode.
 *  Modes never chain or fall back into one another.
 *  - dev:  a fixed configured principal is attached to every request. Request headers,
 *          query strings and cookies are NEVER trusted; OIDC is not attempted.
 *  - oidc: a bearer access token is validated per request; on absence or any failure
 *          the principal is null (→ 401) and there is no dev fallback.
 *  - none: no principal is ever attached (→ 401 on protected routes). */
export function registerAuth(app: FastifyInstance, config: Config, deps: AuthDeps = {}): void {
  app.decorateRequest('principal', null);

  if (config.authMode === 'dev') {
    const devPrincipal = buildPrincipal({
      subject: config.devUser.id,
      displayName: config.devUser.name,
      email: config.devUser.email,
      roles: [config.devUser.role],
      authenticationMethod: 'dev',
    });
    app.addHook('onRequest', async (req: FastifyRequest) => {
      req.principal = devPrincipal;
    });
    app.log.warn(
      { subject: config.devUser.id, role: config.devUser.role },
      'Development Authentication is ENABLED — a fixed dev principal is used for every request. Never enable in production.',
    );
    return;
  }

  if (config.authMode === 'oidc') {
    const verifier = deps.oidcVerifier;
    if (!verifier) throw new Error('OIDC authentication is enabled but no verifier was provided.');
    app.addHook('onRequest', async (req: FastifyRequest) => {
      const token = bearer(req.headers.authorization);
      if (!token) {
        req.principal = null;
        return;
      }
      try {
        req.principal = await verifier.verify(token);
      } catch (err) {
        req.principal = null; // never fall back to a development principal
        req.log.info({ correlationId: req.id, reason: err instanceof Error ? err.message : 'invalid token' }, 'bearer token rejected');
      }
    });
    app.log.info({ issuer: config.oidc?.issuerUrl, tenant: config.oidc?.allowedTenantId }, 'OIDC authentication enabled');
    return;
  }

  // none
  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.principal = null;
  });
  app.log.warn('No authentication is configured — protected routes will return 401. Set RADAR_DEV_AUTH or OIDC_ENABLED.');
}

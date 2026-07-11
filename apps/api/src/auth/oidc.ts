// OIDC bearer access-token validation. Standards-compliant JWT verification via jose
// (no hand-rolled crypto); Microsoft Entra ID is the production provider but any
// standards-compliant OIDC provider (e.g. Keycloak) works. Entra app roles are mapped
// to the locked RADAR roles; permissions are derived by the central role hierarchy —
// never taken from the token. The verifier is injectable so tests never call Microsoft.
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { OidcConfig } from '../config.js';
import type { RadarRole } from './permissions.js';
import { buildPrincipal, type RadarPrincipal } from './principal.js';

/** A token was cryptographically valid-or-not but is not acceptable → 401. */
export class OidcError extends Error {
  constructor(public readonly reason: string) {
    super(`OIDC token rejected: ${reason}`);
    this.name = 'OidcError';
  }
}

export interface OidcVerifier {
  /** Verify a bearer token and build a principal, or throw OidcError. A valid token
   *  with no recognised RADAR role yields a principal with empty roles (authenticated,
   *  but unauthorised — guards then return 403, never a default role). */
  verify(token: string): Promise<RadarPrincipal>;
}

/** Map external Entra app-role names to locked RADAR roles, deduplicated. Unrecognised
 *  roles are ignored (they do not fail authentication). */
export function mapRoles(claim: unknown, roleMap: Record<string, RadarRole>): RadarRole[] {
  const raw = Array.isArray(claim) ? claim : typeof claim === 'string' ? [claim] : [];
  const roles = new Set<RadarRole>();
  for (const r of raw) {
    const mapped = roleMap[String(r)];
    if (mapped) roles.add(mapped);
  }
  return [...roles];
}

export function createOidcVerifier(config: OidcConfig, getKey: JWTVerifyGetKey): OidcVerifier {
  return {
    async verify(token: string): Promise<RadarPrincipal> {
      let payload: JWTPayload;
      try {
        // jose validates signature, algorithm (allow-list), issuer, audience, exp and nbf.
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: config.issuerUrl,
          audience: config.audience,
          algorithms: config.algorithms,
        }));
      } catch (err) {
        throw new OidcError(err instanceof Error ? err.message : 'verification failed');
      }

      // Single-tenant restriction: reject tokens from any other tenant even if otherwise valid.
      const tenant = payload[config.claims.tenant];
      if (tenant !== config.allowedTenantId) {
        throw new OidcError(`wrong tenant (${String(tenant)})`);
      }

      // Stable subject: object id preferred, sub as fallback.
      const subjectClaim = payload[config.claims.subject] ?? payload[config.claims.fallbackSubject];
      if (typeof subjectClaim !== 'string' || subjectClaim.length === 0) {
        throw new OidcError('missing stable subject');
      }

      const displayName = str(payload[config.claims.displayName]);
      const email = str(payload[config.claims.email]);
      const roles = mapRoles(payload[config.claims.roles], config.roleMap);

      return buildPrincipal({ subject: subjectClaim, displayName, email, roles, authenticationMethod: 'oidc' });
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Resolve the JWKS key source: explicit override, else the OIDC discovery document.
 *  Remote key sets cache keys and support rotation. Not used in tests (they inject a
 *  local key set), so Microsoft is never contacted during tests. */
export async function resolveJwks(config: OidcConfig): Promise<JWTVerifyGetKey> {
  const jwksUri = config.jwksUri ?? (await discoverJwksUri(config.issuerUrl));
  return createRemoteJWKSet(new URL(jwksUri));
}

async function discoverJwksUri(issuerUrl: string): Promise<string> {
  const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${url}`);
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
  return doc.jwks_uri;
}

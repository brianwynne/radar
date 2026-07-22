// Cloudflare Access identity. In the production topology Cloudflare Access authenticates users at the
// edge and cloudflared forwards a SIGNED JWT (Cf-Access-Jwt-Assertion) to RADAR. RADAR verifies that
// JWT against the team's public keys (standards-compliant, via jose — no hand-rolled crypto) and
// identifies the caller by their EMAIL. Verifying the signature (not merely trusting a header) means a
// spoofed header cannot impersonate a user even if the origin were ever reachable off-tunnel.
//
// Per the deployment: identity is the email; a single configured RADAR role applies to every verified
// user (the Access policy is what decides who is admitted at all). Group→role mapping is intentionally
// not done here — swap in OIDC later for per-user roles.
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { CfAccessConfig } from '../config.js';
import { buildPrincipal, type RadarPrincipal } from './principal.js';

/** The Access assertion was cryptographically valid-or-not but is not acceptable → 401. */
export class CfAccessError extends Error {
  constructor(public readonly reason: string) {
    super(`Cloudflare Access token rejected: ${reason}`);
    this.name = 'CfAccessError';
  }
}

export interface CfAccessVerifier {
  /** Verify an Access JWT and build a principal (identity = email), or throw CfAccessError. */
  verify(token: string): Promise<RadarPrincipal>;
}

export function createCfAccessVerifier(config: CfAccessConfig, getKey: JWTVerifyGetKey): CfAccessVerifier {
  return {
    async verify(token: string): Promise<RadarPrincipal> {
      let payload: JWTPayload;
      try {
        // jose validates signature, algorithm (fixed allow-list), issuer, audience, exp and nbf.
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: config.issuerUrl,
          audience: config.audience,
          algorithms: config.algorithms,
        }));
      } catch (err) {
        throw new CfAccessError(err instanceof Error ? err.message : 'verification failed');
      }

      const email = payload[config.emailClaim];
      if (typeof email !== 'string' || email.length === 0) throw new CfAccessError('missing email claim');

      // Identity IS the email (lower-cased for a stable subject); one configured role for every user.
      return buildPrincipal({
        subject: email.toLowerCase(),
        displayName: email,
        email,
        roles: [config.role],
        authenticationMethod: 'cf-access',
      });
    },
  };
}

/** JWKS source for the Access team's certs endpoint. Caches keys and supports rotation; the key set
 *  is fetched lazily on first verify, so construction contacts nothing (tests inject a local set). */
export function resolveCfAccessJwks(config: CfAccessConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(config.jwksUri));
}

import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createOidcVerifier, mapRoles, OidcError } from '../src/auth/oidc.js';
import { requirePermission } from '../src/auth/guards.js';

const ISSUER = 'https://login.microsoftonline.com/tenant-rte/v2.0';
const AUDIENCE = 'api://radar';
const TENANT = 'tenant-rte';
const KID = 'test-key-1';

let getKey: JWTVerifyGetKey;
let signingKey: KeyLike;
let otherKey: KeyLike;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signingKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  getKey = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

const oidcEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  OIDC_ENABLED: 'true',
  OIDC_ISSUER_URL: ISSUER,
  OIDC_AUDIENCE: AUDIENCE,
  OIDC_ALLOWED_TENANT_ID: TENANT,
};

const cfg = () => loadConfig(oidcEnv);
const verifier = () => createOidcVerifier(cfg().oidc!, getKey);

async function token(
  claims: Record<string, unknown>,
  opts: { key?: KeyLike; issuer?: string; audience?: string; expired?: boolean } = {},
): Promise<string> {
  const s = new SignJWT({ tid: TENANT, oid: 'user-oid-1', name: 'Test User', preferred_username: 'test@rte.ie', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expired ? '-1m' : '5m');
  return s.sign(opts.key ?? signingKey);
}

describe('role mapping', () => {
  const map = { 'RADAR.Engineer': 'ENGINEER', 'RADAR.NOCViewer': 'NOC_VIEWER' } as const;
  it('maps known roles, ignores unknown, deduplicates', () => {
    expect(mapRoles(['RADAR.Engineer', 'RADAR.Engineer', 'Something'], map)).toEqual(['ENGINEER']);
    expect(mapRoles('RADAR.NOCViewer', map)).toEqual(['NOC_VIEWER']);
    expect(mapRoles(undefined, map)).toEqual([]);
  });
});

describe('token verification', () => {
  it('maps multiple app roles → RADAR roles (deduped) and derives permissions centrally', async () => {
    const t = await token({ roles: ['RADAR.NOCViewer', 'RADAR.ViewingEngineer', 'RADAR.NOCViewer'] });
    const p = await verifier().verify(t);
    expect(p.roles.sort()).toEqual(['NOC_VIEWER', 'VIEWING_ENGINEER']);
    expect(p.permissions).toContain('dashboard.read'); // NOC
    expect(p.permissions).toContain('dns.explain.read'); // VE
    expect(p.permissions).not.toContain('topology.manage'); // engineer-only
    expect(p.authenticationMethod).toBe('oidc');
    expect(p.subject).toBe('user-oid-1');
    expect(p.displayName).toBe('Test User');
  });

  it('uses the sub fallback when the object id is absent', async () => {
    const t = await token({ oid: undefined, sub: 'sub-fallback-1', roles: ['RADAR.NOCViewer'] });
    expect((await verifier().verify(t)).subject).toBe('sub-fallback-1');
  });

  it('accepts a valid token with no recognised RADAR role (empty roles, no default)', async () => {
    const t = await token({ roles: ['SomethingUnrelated'] });
    const p = await verifier().verify(t);
    expect(p.roles).toEqual([]);
    expect(p.permissions).toEqual([]);
  });

  it('rejects another tenant', async () => {
    await expect(verifier().verify(await token({ tid: 'other-tenant', roles: ['RADAR.Engineer'] }))).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects the wrong audience', async () => {
    await expect(verifier().verify(await token({ roles: ['RADAR.Engineer'] }, { audience: 'api://someone-else' }))).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects the wrong issuer', async () => {
    await expect(verifier().verify(await token({ roles: ['RADAR.Engineer'] }, { issuer: 'https://evil.example/v2.0' }))).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects an expired token', async () => {
    await expect(verifier().verify(await token({ roles: ['RADAR.Engineer'] }, { expired: true }))).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects a signature from an unknown key', async () => {
    await expect(verifier().verify(await token({ roles: ['RADAR.Engineer'] }, { key: otherKey }))).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects a token missing a stable subject', async () => {
    await expect(verifier().verify(await token({ oid: undefined, roles: ['RADAR.Engineer'] }))).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects an unsigned (alg=none) token', async () => {
    const t = new UnsecuredJWT({ tid: TENANT, oid: 'x', roles: ['RADAR.Engineer'] })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').encode();
    await expect(verifier().verify(t)).rejects.toBeInstanceOf(OidcError);
  });
  it('rejects a malformed JWT', async () => {
    await expect(verifier().verify('not.a.jwt')).rejects.toBeInstanceOf(OidcError);
  });
});

describe('configuration', () => {
  it('fails fast when OIDC is enabled but incomplete', () => {
    expect(() => loadConfig({ OIDC_ENABLED: 'true' })).toThrow(/incomplete/i);
  });
  it('development authentication takes precedence over OIDC', () => {
    const c = loadConfig({ ...oidcEnv, RADAR_DEV_AUTH: 'true' });
    expect(c.authMode).toBe('dev');
    expect(c.oidc).toBeUndefined();
  });
  it('resolves authMode=oidc when enabled and complete', () => {
    expect(cfg().authMode).toBe('oidc');
  });
});

describe('OIDC integration through the app', () => {
  async function oidcApp() {
    const config = cfg();
    const app = await buildApp(config, { oidcVerifier: createOidcVerifier(config.oidc!, getKey) });
    app.get('/api/v1/_test/engineer-only', { preHandler: requirePermission('topology.manage') }, async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('GET /api/v1/me with a valid engineer token → 200 oidc principal', async () => {
    const app = await oidcApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${await token({ roles: ['RADAR.Engineer'] })}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual(['ENGINEER']);
    expect(res.json().authenticationMethod).toBe('oidc');
    expect(res.json().developmentAuthentication).toBe(false);
    await app.close();
  });

  it('returns 401 with no token and 401 with an invalid token (no dev fallback)', async () => {
    const app = await oidcApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    const bad = await token({ roles: ['RADAR.Engineer'] }, { key: otherKey });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${bad}` } })).statusCode).toBe(401);
    await app.close();
  });

  it('valid token without a RADAR role: 200 on /me but 403 on a permissioned route', async () => {
    const app = await oidcApp();
    const auth = { authorization: `Bearer ${await token({ roles: ['SomethingUnrelated'] })}` };
    expect((await app.inject({ method: 'GET', url: '/api/v1/_test/engineer-only', headers: auth })).statusCode).toBe(403);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json().roles).toEqual([]);
    await app.close();
  });

  it('viewing-engineer token is denied an engineer-only permission (403)', async () => {
    const app = await oidcApp();
    const auth = { authorization: `Bearer ${await token({ roles: ['RADAR.ViewingEngineer'] })}` };
    expect((await app.inject({ method: 'GET', url: '/api/v1/_test/engineer-only', headers: auth })).statusCode).toBe(403);
    await app.close();
  });

  it('readiness reports the oidc authentication mode', async () => {
    const app = await oidcApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/health/ready' })).json().checks.auth).toBe('oidc');
    await app.close();
  });
});

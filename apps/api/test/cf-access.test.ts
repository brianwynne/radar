import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createCfAccessVerifier, CfAccessError } from '../src/auth/cf-access.js';

const TEAM = 'rte';
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = 'aud-tag-abc123';
const KID = 'cf-key-1';

let getKey: JWTVerifyGetKey;
let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  signingKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID; jwk.alg = 'RS256'; jwk.use = 'sig';
  getKey = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;
});

const env: Record<string, string> = {
  NODE_ENV: 'test', LOG_LEVEL: 'silent',
  CF_ACCESS_ENABLED: 'true', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, CF_ACCESS_ROLE: 'ENGINEER',
};
const cfg = () => loadConfig(env);
const verifier = () => createCfAccessVerifier(cfg().cfAccess!, getKey);

async function token(
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; issuer?: string; audience?: string; expired?: boolean } = {},
): Promise<string> {
  return new SignJWT({ email: 'jane.doe@rte.ie', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.expired ? '-1m' : '5m')
    .sign(opts.key ?? signingKey);
}

describe('config', () => {
  it('derives issuer + certs URL from a bare team name and selects cf-access mode', () => {
    const c = cfg();
    expect(c.authMode).toBe('cf-access');
    expect(c.cfAccess).toMatchObject({ issuerUrl: ISSUER, audience: AUD, jwksUri: `${ISSUER}/cdn-cgi/access/certs`, role: 'ENGINEER', emailClaim: 'email' });
  });
  it('fails startup when enabled but incomplete', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', CF_ACCESS_ENABLED: 'true' })).toThrow(/CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD/);
  });
});

describe('assertion verification', () => {
  it('builds a principal keyed on the email, with the configured role', async () => {
    const p = await verifier().verify(await token({ email: 'Jane.Doe@rte.ie' }));
    expect(p.authenticationMethod).toBe('cf-access');
    expect(p.subject).toBe('jane.doe@rte.ie'); // lower-cased email = stable identity
    expect(p.email).toBe('Jane.Doe@rte.ie');
    expect(p.roles).toEqual(['ENGINEER']);
    expect(p.permissions).toContain('ns1.record.create'); // engineer role applied
  });
  it('rejects an assertion with no email claim', async () => {
    await expect(verifier().verify(await token({ email: undefined }))).rejects.toBeInstanceOf(CfAccessError);
  });
  it('rejects the wrong audience', async () => {
    await expect(verifier().verify(await token({}, { audience: 'someone-else' }))).rejects.toBeInstanceOf(CfAccessError);
  });
  it('rejects the wrong issuer (another team)', async () => {
    await expect(verifier().verify(await token({}, { issuer: 'https://evil.cloudflareaccess.com' }))).rejects.toBeInstanceOf(CfAccessError);
  });
  it('rejects an expired assertion', async () => {
    await expect(verifier().verify(await token({}, { expired: true }))).rejects.toBeInstanceOf(CfAccessError);
  });
  it('rejects a signature from an unknown key (cannot be spoofed)', async () => {
    await expect(verifier().verify(await token({}, { key: otherKey }))).rejects.toBeInstanceOf(CfAccessError);
  });
});

describe('through the app (onRequest hook)', () => {
  const build = () => buildApp(cfg(), { cfAccessVerifier: verifier() });

  it('401 when the Access header is absent', async () => {
    const a = await build();
    expect((await a.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
    await a.close();
  });
  it('authenticates a request carrying a valid Cf-Access-Jwt-Assertion', async () => {
    const a = await build();
    const res = await a.inject({ url: '/api/v1/me', headers: { 'cf-access-jwt-assertion': await token() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'jane.doe@rte.ie', authenticationMethod: 'cf-access' });
    await a.close();
  });
  it('401 on a forged assertion (unknown signing key)', async () => {
    const a = await build();
    const res = await a.inject({ url: '/api/v1/me', headers: { 'cf-access-jwt-assertion': await token({}, { key: otherKey }) } });
    expect(res.statusCode).toBe(401);
    await a.close();
  });
});

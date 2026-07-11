// Environment-based configuration for radar-api. Validated at startup with zod;
// invalid configuration fails fast (readiness depends on this loading cleanly).
import { z } from 'zod';
import type { RadarRole } from './auth/permissions.js';
import { loadDatabaseConfig, type DatabaseConfig } from './database/config.js';
import { loadNs1Config, type Ns1Config } from './ns1/config.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Maximum accepted request body in bytes (default 64 KiB). Enforced early and by Fastify.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(64 * 1024),

  // Development authentication (no IdP). Real OIDC arrives next.
  RADAR_DEV_AUTH: z.string().optional(),
  RADAR_ALLOW_DEV_AUTH_IN_PRODUCTION: z.string().optional(),
  RADAR_DEV_USER_ID: z.string().default('dev-engineer'),
  RADAR_DEV_USER_NAME: z.string().default('Development Engineer'),
  RADAR_DEV_USER_EMAIL: z.string().default('dev-engineer@example.invalid'),
  // Least-privilege application default; .env.example may demonstrate a higher role.
  RADAR_DEV_ROLE: z.enum(['NOC_VIEWER', 'VIEWING_ENGINEER', 'ENGINEER']).default('NOC_VIEWER'),

  // OIDC (production; Microsoft Entra ID or any standards-compliant provider).
  OIDC_ENABLED: z.string().optional(),
  OIDC_ISSUER_URL: z.string().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_ALLOWED_TENANT_ID: z.string().optional(),
  OIDC_JWKS_URI: z.string().optional(), // explicit override; otherwise discovered
  OIDC_SUBJECT_CLAIM: z.string().default('oid'),
  OIDC_FALLBACK_SUBJECT_CLAIM: z.string().default('sub'),
  OIDC_DISPLAY_NAME_CLAIM: z.string().default('name'),
  OIDC_EMAIL_CLAIM: z.string().default('preferred_username'),
  OIDC_ROLES_CLAIM: z.string().default('roles'),
  OIDC_TENANT_CLAIM: z.string().default('tid'),
  OIDC_ROLE_NOC_VIEWER: z.string().default('RADAR.NOCViewer'),
  OIDC_ROLE_VIEWING_ENGINEER: z.string().default('RADAR.ViewingEngineer'),
  OIDC_ROLE_ENGINEER: z.string().default('RADAR.Engineer'),
});

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const parseBool = (v: string | undefined): boolean => v !== undefined && TRUTHY.has(v.toLowerCase());

export type AuthMode = 'dev' | 'oidc' | 'none';

export interface OidcConfig {
  issuerUrl: string;
  audience: string;
  allowedTenantId: string;
  jwksUri?: string;
  claims: {
    subject: string;
    fallbackSubject: string;
    displayName: string;
    email: string;
    roles: string;
    tenant: string;
  };
  /** External app-role name → locked RADAR role. */
  roleMap: Record<string, RadarRole>;
  /** Trusted signing algorithms (allow-list; not taken from the token header). */
  algorithms: string[];
}

export interface Config {
  NODE_ENV: 'development' | 'production' | 'test';
  API_HOST: string;
  API_PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  MAX_BODY_BYTES: number;
  authMode: AuthMode;
  devAuth: boolean;
  allowDevAuthInProduction: boolean;
  devUser: { id: string; name: string; email: string; role: RadarRole };
  oidc?: OidcConfig;
  /** Present when DATABASE_URL is configured. Its absence is a startup error in
   *  server.ts (the API cannot function without persistence); leaving it optional here
   *  keeps configuration-only unit tests independent of a database. */
  database?: DatabaseConfig;
  /** NS1 read-only client configuration (mock by default; live requires a read-only key). */
  ns1: Ns1Config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid RADAR configuration: ${detail}`);
  }
  const p = parsed.data;
  const devAuth = parseBool(p.RADAR_DEV_AUTH);
  const allowDevAuthInProduction = parseBool(p.RADAR_ALLOW_DEV_AUTH_IN_PRODUCTION);

  // Production safety: development authentication must never run in production unless
  // an explicit, deliberate override is provided. Default is to fail startup.
  if (p.NODE_ENV === 'production' && devAuth && !allowDevAuthInProduction) {
    throw new Error(
      'Refusing to start: RADAR_DEV_AUTH is enabled in production. Set RADAR_ALLOW_DEV_AUTH_IN_PRODUCTION=true only if you deliberately intend this (strongly discouraged).',
    );
  }

  // Authentication precedence: dev-auth wins and disables OIDC entirely; otherwise
  // OIDC if enabled; otherwise none (protected routes 401). Never a fallback chain.
  let oidc: OidcConfig | undefined;
  if (!devAuth && parseBool(p.OIDC_ENABLED)) {
    const missing: string[] = [];
    if (!p.OIDC_ISSUER_URL) missing.push('OIDC_ISSUER_URL');
    if (!p.OIDC_AUDIENCE) missing.push('OIDC_AUDIENCE');
    if (!p.OIDC_ALLOWED_TENANT_ID) missing.push('OIDC_ALLOWED_TENANT_ID');
    if (missing.length > 0) {
      throw new Error(`OIDC is enabled but its configuration is incomplete: missing ${missing.join(', ')}.`);
    }
    oidc = {
      issuerUrl: p.OIDC_ISSUER_URL as string,
      audience: p.OIDC_AUDIENCE as string,
      allowedTenantId: p.OIDC_ALLOWED_TENANT_ID as string,
      jwksUri: p.OIDC_JWKS_URI,
      claims: {
        subject: p.OIDC_SUBJECT_CLAIM,
        fallbackSubject: p.OIDC_FALLBACK_SUBJECT_CLAIM,
        displayName: p.OIDC_DISPLAY_NAME_CLAIM,
        email: p.OIDC_EMAIL_CLAIM,
        roles: p.OIDC_ROLES_CLAIM,
        tenant: p.OIDC_TENANT_CLAIM,
      },
      roleMap: {
        [p.OIDC_ROLE_NOC_VIEWER]: 'NOC_VIEWER',
        [p.OIDC_ROLE_VIEWING_ENGINEER]: 'VIEWING_ENGINEER',
        [p.OIDC_ROLE_ENGINEER]: 'ENGINEER',
      },
      algorithms: ['RS256'], // Entra signs with RS256; allow-list is fixed, not token-driven.
    };
  }

  const authMode: AuthMode = devAuth ? 'dev' : oidc ? 'oidc' : 'none';

  // Validate database configuration when DATABASE_URL is supplied. Invalid values (e.g.
  // pool sizes) fail fast here; server.ts requires the result to be present to start.
  const database = env.DATABASE_URL ? loadDatabaseConfig(env) : undefined;

  // NS1 client config: mock by default (no credential); live-mode validation (HTTPS +
  // read-only key present) happens here so misconfiguration fails startup.
  const ns1 = loadNs1Config(env);

  return {
    NODE_ENV: p.NODE_ENV,
    API_HOST: p.API_HOST,
    API_PORT: p.API_PORT,
    LOG_LEVEL: p.LOG_LEVEL,
    MAX_BODY_BYTES: p.MAX_BODY_BYTES,
    authMode,
    devAuth,
    allowDevAuthInProduction,
    devUser: { id: p.RADAR_DEV_USER_ID, name: p.RADAR_DEV_USER_NAME, email: p.RADAR_DEV_USER_EMAIL, role: p.RADAR_DEV_ROLE },
    oidc,
    database,
    ns1,
  };
}

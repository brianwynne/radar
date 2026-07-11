// Environment-based configuration for radar-api. Validated at startup with zod;
// invalid configuration fails fast (readiness depends on this loading cleanly).
import { z } from 'zod';
import type { RadarRole } from './auth/permissions.js';

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
  RADAR_DEV_ROLE: z.enum(['NOC_VIEWER', 'VIEWING_ENGINEER', 'ENGINEER']).default('VIEWING_ENGINEER'),
});

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const parseBool = (v: string | undefined): boolean => v !== undefined && TRUTHY.has(v.toLowerCase());

export interface Config {
  NODE_ENV: 'development' | 'production' | 'test';
  API_HOST: string;
  API_PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  MAX_BODY_BYTES: number;
  devAuth: boolean;
  allowDevAuthInProduction: boolean;
  devUser: { id: string; name: string; email: string; role: RadarRole };
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

  return {
    NODE_ENV: p.NODE_ENV,
    API_HOST: p.API_HOST,
    API_PORT: p.API_PORT,
    LOG_LEVEL: p.LOG_LEVEL,
    MAX_BODY_BYTES: p.MAX_BODY_BYTES,
    devAuth,
    allowDevAuthInProduction,
    devUser: { id: p.RADAR_DEV_USER_ID, name: p.RADAR_DEV_USER_NAME, email: p.RADAR_DEV_USER_EMAIL, role: p.RADAR_DEV_ROLE },
  };
}

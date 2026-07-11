// Environment-based configuration for radar-api. Validated at startup with zod;
// invalid configuration fails fast (readiness depends on this loading cleanly).
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Maximum accepted request body in bytes (default 64 KiB). Enforced early and by Fastify.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(64 * 1024),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid RADAR configuration: ${detail}`);
  }
  return parsed.data;
}

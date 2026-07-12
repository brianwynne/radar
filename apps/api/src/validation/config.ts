// Validation configuration. Validation is READ-ONLY. Running it against a LIVE NS1 account is
// gated behind an explicit enable flag (controlled live-validation mode) so live NS1 is never
// queried by accident; mock-mode validation is always allowed. This never enables any write.
import { z } from 'zod';

export interface ValidationConfig {
  /** Allow running validation against a LIVE NS1 account (default false). Mock mode ignores this. */
  liveValidationEnabled: boolean;
}

const schema = z.object({
  NS1_VALIDATION_ENABLED: z.string().optional(),
});

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function loadValidationConfig(env: NodeJS.ProcessEnv = process.env): ValidationConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid validation configuration: ${detail}`);
  }
  return { liveValidationEnabled: parsed.data.NS1_VALIDATION_ENABLED !== undefined && TRUTHY.has(parsed.data.NS1_VALIDATION_ENABLED.toLowerCase()) };
}

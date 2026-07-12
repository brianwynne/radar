// NS1 live-validation module (read-only). Builds a ValidationService over the existing
// read-only NS1 client; running against a live account is gated by NS1_VALIDATION_ENABLED.
import type { Ns1ReadClient } from '../ns1/client.js';
import type { RadarMode } from '../ns1/config.js';
import type { ValidationResultRepository } from '@radar/data';
import { ValidationService } from './service.js';
import type { ValidationConfig } from './config.js';

export { loadValidationConfig, type ValidationConfig } from './config.js';
export { ValidationService } from './service.js';
export { analyse, SUPPORTED_FILTERS, structurePaths } from './analysis.js';
export { redactDeep, redactedPaths, isSensitiveKey } from './redact.js';
export { buildFixtureCandidate } from './fixture.js';
export type * from './types.js';

export interface CreateValidationOptions {
  client: Ns1ReadClient;
  mode: RadarMode;
  config: ValidationConfig;
  repository?: ValidationResultRepository;
  now?: () => number;
}

export function createValidationService(opts: CreateValidationOptions): ValidationService {
  return new ValidationService({ client: opts.client, mode: opts.mode, liveValidationEnabled: opts.config.liveValidationEnabled, repository: opts.repository, now: opts.now });
}

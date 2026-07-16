// Cloudflare connector module. The factory selects disabled / mock / live from config and returns
// a read-only CloudflareClient producing RADAR's canonical CloudflareSnapshot. Cloudflare wire
// types never escape this module (they live in http-client).
import type { CloudflareConfig } from './config.js';
import { HttpCloudflareReadClient } from './http-client.js';
import { DisabledCloudflareClient, MockCloudflareClient } from './mock-client.js';
import type { CloudflareClient } from './types.js';

export { loadCloudflareConfig, type CloudflareConfig, type CloudflareMode } from './config.js';
export { CloudflareError, type CloudflareErrorCode } from './errors.js';
export { HttpCloudflareReadClient } from './http-client.js';
export { MockCloudflareClient, DisabledCloudflareClient } from './mock-client.js';
export { CloudflarePoller, type CloudflareConnectorStatus, type CloudflarePollerDeps } from './poller.js';
export type * from './types.js';

export interface CloudflareClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export function createCloudflareClient(config: CloudflareConfig, deps: CloudflareClientDeps = {}): CloudflareClient {
  if (!config.enabled) return new DisabledCloudflareClient(deps.now);
  if (config.mode === 'mock') return new MockCloudflareClient(deps.now);
  // Live: the config loader guarantees token + accountId are present.
  return new HttpCloudflareReadClient({
    apiBase: config.apiBase,
    token: config.token!,
    accountId: config.accountId!,
    lbZones: config.lbZones,
    timeoutMs: config.timeoutSeconds * 1000,
    maxRetries: config.retryAttempts,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    logger: deps.logger,
  });
}

// Fastly connector module. The factory selects disabled / mock / live from config and returns a
// read-only FastlyClient producing RADAR's canonical FastlySnapshot. Fastly wire types never
// escape this module (they live in http-client).
import type { FastlyConfig } from './config.js';
import { HttpFastlyReadClient } from './http-client.js';
import { DisabledFastlyClient, MockFastlyClient } from './mock-client.js';
import type { FastlyClient } from './types.js';

export { loadFastlyConfig, type FastlyConfig, type FastlyMode } from './config.js';
export { FastlyError, type FastlyErrorCode } from './errors.js';
export { HttpFastlyReadClient } from './http-client.js';
export { MockFastlyClient, DisabledFastlyClient } from './mock-client.js';
export { FastlyPoller, type FastlyConnectorStatus, type FastlyPollerDeps } from './poller.js';
export type * from './types.js';

export interface FastlyClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export function createFastlyClient(config: FastlyConfig, deps: FastlyClientDeps = {}): FastlyClient {
  if (!config.enabled) return new DisabledFastlyClient(deps.now);
  if (config.mode === 'mock') return new MockFastlyClient(deps.now);
  // Live: the config loader guarantees the token is present.
  return new HttpFastlyReadClient({
    apiBase: config.apiBase,
    token: config.token!,
    serviceIds: config.serviceIds,
    windowMinutes: config.windowMinutes,
    timeoutMs: config.timeoutSeconds * 1000,
    maxRetries: config.retryAttempts,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    logger: deps.logger,
  });
}

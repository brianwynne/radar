// Fastly connector module. The factory selects disabled / mock / live from config and returns a
// read-only FastlyClient producing RADAR's canonical FastlySnapshot. Fastly wire types never
// escape this module (they live in http-client).
import type { FastlyConfig } from './config.js';
import { HttpFastlyReadClient } from './http-client.js';
import { DisabledFastlyClient, MockFastlyClient } from './mock-client.js';
import { HttpFastlyRealtimeClient } from './realtime-client.js';
import type { FastlyClient, FastlyRealtimeClient } from './types.js';

export { loadFastlyConfig, type FastlyConfig, type FastlyMode } from './config.js';
export { FastlyError, type FastlyErrorCode } from './errors.js';
export { HttpFastlyReadClient } from './http-client.js';
export { MockFastlyClient, DisabledFastlyClient } from './mock-client.js';
export { HttpFastlyRealtimeClient } from './realtime-client.js';
export {
  FastlyRealtimeStreamer,
  type FastlyRealtimeStatus,
  type FastlyRealtimeServiceStatus,
  type FastlyRealtimeStreamerConfig,
  type FastlyRealtimeStreamerDeps,
} from './realtime-streamer.js';
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

/** Build the real-time (per-second) client, or null when the connector cannot / should not stream:
 *  disabled, mock mode, real-time turned off, or no token. Streaming is a live-only capability —
 *  there is no synthetic per-second stream. */
export function createFastlyRealtimeClient(config: FastlyConfig, deps: FastlyClientDeps = {}): FastlyRealtimeClient | null {
  if (!config.enabled || config.mode !== 'live' || !config.realtimeEnabled) return null;
  if (!config.token) return null;
  return new HttpFastlyRealtimeClient({
    realtimeApiBase: config.realtimeApiBase,
    token: config.token,
    requestTimeoutMs: config.realtimeRequestTimeoutSeconds * 1000,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
}

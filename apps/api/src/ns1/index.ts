// NS1 read-only client module. GET-only; the factory selects the fixture-backed mock
// (no credential) or the live HTTPS client based on RADAR_MODE.
import type { Ns1Config } from './config.js';
import type { Ns1ReadClient } from './client.js';
import { HttpNs1ReadClient } from './http-client.js';
import { MockNs1ReadClient } from './mock-client.js';

export type { RadarMode, Ns1Config } from './config.js';
export { loadNs1Config } from './config.js';
export type { Ns1ReadClient, ActivityQuery } from './client.js';
export { Ns1Error, type Ns1ErrorCode } from './errors.js';
export { HttpNs1ReadClient, type HttpNs1ClientOptions } from './http-client.js';
export { MockNs1ReadClient } from './mock-client.js';

/** Injectable dependencies (tests supply a fake fetch for the live client). */
export interface Ns1ClientDeps {
  fetchImpl?: typeof fetch;
}

/** Build the read-only NS1 client for the configured mode. Mock needs no credential;
 *  live requires the HTTPS base URL and API key already validated by loadNs1Config. */
export function createNs1Client(config: Ns1Config, deps: Ns1ClientDeps = {}): Ns1ReadClient {
  if (config.mode === 'mock') {
    return new MockNs1ReadClient();
  }
  return new HttpNs1ReadClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey as string, // guaranteed present in live mode by loadNs1Config
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    fetchImpl: deps.fetchImpl,
  });
}

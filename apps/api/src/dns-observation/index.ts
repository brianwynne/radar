// DNS Observation module. The factory selects the disabled placeholder, the deterministic
// mock, or the real read-only resolver client from configuration.
import type { Ns1ReadClient } from '../ns1/client.js';
import type { DnsObservationRepository } from '@radar/data';
import { DnsObservationService, type Logger } from './service.js';
import { DisabledDnsObservationClient, MockDnsObservationClient, ResolverDnsObservationClient } from './clients.js';
import { UdpDnsTransport } from './udp-transport.js';
import type { DnsObservationConfig } from './config.js';
import type { DnsObservationClient, DnsTransport } from './types.js';

export { loadDnsObservationConfig, type DnsObservationConfig, type DnsObservationMode } from './config.js';
export { DnsObservationService } from './service.js';
export { DNS_OBSERVATION_SCENARIOS } from './scenarios.js';
export { compareObservation, classifyConfidence, classifyObservationChange } from './compare.js';
export { DisabledDnsObservationClient, MockDnsObservationClient, ResolverDnsObservationClient } from './clients.js';
export { UdpDnsTransport } from './udp-transport.js';
export { encodeQuery, decodeResponse } from './dns-wire.js';
export type * from './types.js';

export interface CreateDnsObservationOptions {
  ns1Client: Ns1ReadClient;
  config: DnsObservationConfig;
  repository?: DnsObservationRepository;
  logger?: Logger;
  /** Injectable DNS transport (tests); defaults to UDP for resolver mode. */
  transport?: DnsTransport;
  now?: () => number;
}

function createClient(config: DnsObservationConfig, deps: { transport?: DnsTransport; now?: () => number }): DnsObservationClient {
  if (config.mode === 'mock') return new MockDnsObservationClient({ now: deps.now });
  if (config.mode === 'resolver') {
    return new ResolverDnsObservationClient({ transport: deps.transport ?? new UdpDnsTransport(), timeoutMs: config.timeoutMs, now: deps.now });
  }
  return new DisabledDnsObservationClient(deps.now);
}

export function createDnsObservationService(opts: CreateDnsObservationOptions): DnsObservationService {
  return new DnsObservationService({
    client: createClient(opts.config, { transport: opts.transport, now: opts.now }),
    ns1Client: opts.ns1Client,
    repository: opts.repository,
    config: opts.config,
    now: opts.now,
    logger: opts.logger,
  });
}

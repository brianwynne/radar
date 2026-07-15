// CloudVision connector module. The factory selects disabled / mock / live from config and
// returns a read-only CloudVisionClient producing RADAR's canonical NetworkStateSnapshot.
// CloudVision wire types never escape this module (they live in http-client + adapter).
import type { CloudVisionConfig } from './config.js';
import { DisabledCloudVisionClient, MockCloudVisionClient } from './mock-client.js';
import { HttpCloudVisionReadClient } from './http-client.js';
import type { CloudVisionClient } from './types.js';
import type { ScenarioName } from './fixtures.js';

export { loadCloudVisionConfig, type CloudVisionConfig, type CloudVisionMode } from './config.js';
export { CloudVisionError, type CloudVisionErrorCode } from './errors.js';
export { buildSnapshot, emptySnapshot, freshnessOf, normaliseBgpState, counterKey } from './adapter.js';
export type { RawSnapshot, RawDevice, RawInterface, RawBgpPeer, PreviousCounters, AdapterConfig } from './adapter.js';
export { classifyInterface, validateClassificationRules, type ClassificationRule } from './classification.js';
export { deriveBandwidthBps, resolveBandwidth, utilisationPercent, headroomBps } from './throughput.js';
export { MockCloudVisionClient, DisabledCloudVisionClient } from './mock-client.js';
export { HttpCloudVisionReadClient } from './http-client.js';
export { SCENARIOS, MOCK_EDGE_DEVICE_IDS, type ScenarioName } from './fixtures.js';
export { DEFAULT_CLASSIFICATION_RULES, DEFAULT_PROVIDER_FOR_ASN } from './classification-rules.js';
export type * from './types.js';

export interface CloudVisionClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Undici Dispatcher used to honour verifyTls=false (optional). */
  dispatcher?: unknown;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  /** Mock scenario override (defaults to CLOUDVISION_MOCK_SCENARIO env or 'normal'). */
  scenario?: ScenarioName;
}

export function createCloudVisionClient(config: CloudVisionConfig, deps: CloudVisionClientDeps = {}): CloudVisionClient {
  if (!config.enabled) {
    return new DisabledCloudVisionClient(config.maxSampleAgeSeconds, config.edgeDeviceIds, deps.now);
  }

  if (config.mode === 'mock') {
    return new MockCloudVisionClient({
      scenario: deps.scenario ?? (process.env.CLOUDVISION_MOCK_SCENARIO as ScenarioName | undefined) ?? 'normal',
      staleAfterSeconds: config.maxSampleAgeSeconds,
      expectedDeviceIds: config.edgeDeviceIds,
      classificationRules: config.classificationRules,
      providerForAsn: config.providerForAsn,
      warningPercent: config.warningPercent,
      criticalPercent: config.criticalPercent,
      primaryDirection: config.primaryDirection,
      now: deps.now,
    });
  }

  // Live: the config loader guarantees endpoint + token are present.
  return new HttpCloudVisionReadClient({
    endpoint: config.endpoint!,
    token: config.token!,
    timeoutMs: config.timeoutSeconds * 1000,
    maxRetries: config.retryAttempts,
    verifyTls: config.verifyTls,
    staleAfterSeconds: config.maxSampleAgeSeconds,
    expectedDeviceIds: config.edgeDeviceIds,
    classificationRules: config.classificationRules,
    providerForAsn: config.providerForAsn,
    warningPercent: config.warningPercent,
    criticalPercent: config.criticalPercent,
    primaryDirection: config.primaryDirection,
    fetchImpl: deps.fetchImpl,
    dispatcher: deps.dispatcher,
    now: deps.now,
    logger: deps.logger,
  });
}

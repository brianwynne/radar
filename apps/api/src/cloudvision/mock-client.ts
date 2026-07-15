// Mock + disabled CloudVision clients. The mock drives the SAME adapter and APIs as live —
// it swaps only the data source. Scenarios exercise every code path (failures, staleness,
// counter resets, partial responses, auth failure). No credentials are ever required.
import { buildSnapshot, emptySnapshot, type AdapterConfig } from './adapter.js';
import { CloudVisionError } from './errors.js';
import { scenarioSnapshot, type ScenarioName } from './fixtures.js';
import type { ClassificationRule } from './classification.js';
import type { CloudVisionClient, NetworkStateSnapshot } from './types.js';

export interface MockClientOptions {
  scenario?: ScenarioName;
  staleAfterSeconds: number;
  expectedDeviceIds: string[];
  classificationRules: ClassificationRule[];
  providerForAsn?: Record<number, string>;
  warningPercent: number;
  criticalPercent: number;
  primaryDirection?: 'inbound' | 'outbound';
  now?: () => number;
}

export class MockCloudVisionClient implements CloudVisionClient {
  private readonly scenario: ScenarioName;
  private readonly now: () => number;

  constructor(private readonly opts: MockClientOptions) {
    this.scenario = opts.scenario ?? 'normal';
    this.now = opts.now ?? (() => Date.now());
  }

  async getSnapshot(correlationId?: string): Promise<NetworkStateSnapshot> {
    if (this.scenario === 'auth-failure') {
      throw new CloudVisionError('CLOUDVISION_AUTH', undefined, { status: 401, correlationId });
    }
    const now = this.now();
    const raw = scenarioSnapshot(this.scenario, now);
    const cfg: AdapterConfig = {
      source: 'mock',
      synthetic: true,
      now,
      staleAfterSeconds: this.opts.staleAfterSeconds,
      expectedDeviceIds: this.opts.expectedDeviceIds,
      classificationRules: this.opts.classificationRules,
      providerForAsn: this.opts.providerForAsn,
      warningPercent: this.opts.warningPercent,
      criticalPercent: this.opts.criticalPercent,
      primaryDirection: this.opts.primaryDirection,
    };
    return buildSnapshot(raw, cfg);
  }
}

/** Disabled connector: an honest "not connected" snapshot, never an invented value. */
export class DisabledCloudVisionClient implements CloudVisionClient {
  constructor(
    private readonly staleAfterSeconds: number,
    private readonly expectedDeviceIds: string[] = [],
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getSnapshot(): Promise<NetworkStateSnapshot> {
    return emptySnapshot({ source: 'disabled', synthetic: false, now: this.now(), staleAfterSeconds: this.staleAfterSeconds, expectedDeviceIds: this.expectedDeviceIds });
  }
}

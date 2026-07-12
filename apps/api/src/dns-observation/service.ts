// DNS Observation service. Orchestrates one read-only observation cycle per ISP: predict via
// the engine, observe via the DNS client, compare, and persist a bounded history row. RADAR
// stays the analysis plane — it never writes to NS1 or Cloudflare, never claims anything
// about actual traffic, and never treats one observation as proof of the distribution.
//
// Optional periodic observation is OFF by default; when on it runs no more often than the
// configured (floored) interval, with bounded concurrency, per-ISP failure isolation, and
// exponential backoff on repeated cycle failure. No aggressive probing.
import { normaliseRecord } from '../ns1/normalise.js';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { DnsObservationRepository, DnsObservationRecord } from '@radar/data';
import { buildPredictedSteering } from './predicted.js';
import { compareObservation } from './compare.js';
import { DNS_OBSERVATION_SCENARIOS } from './scenarios.js';
import type { DnsObservationConfig } from './config.js';
import type { ComparisonResult, DnsObservationClient, DnsObservationScenario, PredictedSteering, RawObservation } from './types.js';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}
const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface DnsObservationDeps {
  client: DnsObservationClient;
  ns1Client: Ns1ReadClient;
  repository?: DnsObservationRepository;
  config: DnsObservationConfig;
  scenarios?: DnsObservationScenario[];
  now?: () => number;
  logger?: Logger;
}

export interface ObservationOutcome {
  scenario: DnsObservationScenario;
  predicted: PredictedSteering;
  observed: RawObservation;
  comparison: ComparisonResult;
  record?: DnsObservationRecord;
}

export class DnsObservationService {
  private readonly client: DnsObservationClient;
  private readonly ns1Client: Ns1ReadClient;
  private readonly repository?: DnsObservationRepository;
  private readonly config: DnsObservationConfig;
  private readonly scenarios: DnsObservationScenario[];
  private readonly now: () => number;
  private readonly logger: Logger;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;

  constructor(deps: DnsObservationDeps) {
    this.client = deps.client;
    this.ns1Client = deps.ns1Client;
    this.repository = deps.repository;
    this.config = deps.config;
    this.scenarios = deps.scenarios ?? DNS_OBSERVATION_SCENARIOS;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? noopLogger;
  }

  get mode(): string {
    return this.client.mode;
  }
  getScenarios(): DnsObservationScenario[] {
    return this.scenarios;
  }
  findScenario(ispId: string): DnsObservationScenario | undefined {
    return this.scenarios.find((s) => s.ispId === ispId);
  }

  /** Observe one ISP: predict, observe, compare, persist. Never throws. */
  async run(ispId: string, correlationId?: string): Promise<ObservationOutcome | null> {
    const scenario = this.findScenario(ispId);
    if (!scenario) return null;

    let predicted: PredictedSteering;
    try {
      const raw = await this.ns1Client.getRecord(scenario.zone, scenario.domain, scenario.recordType, correlationId);
      predicted = buildPredictedSteering(raw, normaliseRecord(raw), scenario);
    } catch (err) {
      this.logger.warn({ ispId, err: err instanceof Error ? err.name : 'error' }, 'dns-observation: prediction failed');
      // Cannot predict → still record an unavailable observation for honesty.
      predicted = { answers: [], answerIps: [], distribution: [], complete: false, unsupportedFilters: [], expectsSubsetSelection: false, recordChecksum: 'sha256:unknown' };
    }

    const observed = await this.client.observe(scenario, correlationId);
    const comparison = compareObservation(predicted, observed, scenario);
    const record = await this.persist(scenario, predicted, observed, comparison, correlationId);
    return { scenario, predicted, observed, comparison, record };
  }

  private async persist(scenario: DnsObservationScenario, predicted: PredictedSteering, observed: RawObservation, comparison: ComparisonResult, correlationId?: string): Promise<DnsObservationRecord | undefined> {
    if (!this.repository) return undefined;
    try {
      return await this.repository.create({
        ispId: scenario.ispId,
        ispName: scenario.ispName,
        asn: scenario.asn,
        resolverIp: observed.resolverIp,
        zone: scenario.zone,
        domain: scenario.domain,
        recordType: scenario.recordType,
        ecsRequested: observed.ecsRequested,
        ecsPrefix: observed.ecsPrefix,
        ecsHonoured: observed.ecsHonoured,
        responseCode: observed.responseCode,
        observedAnswers: observed.answers,
        predictedAnswers: predicted.answers,
        comparisonStatus: comparison.comparisonStatus,
        confidence: comparison.confidence,
        ttl: observed.ttl,
        latencyMs: observed.latencyMs,
        recordChecksum: predicted.recordChecksum,
        explanation: comparison.explanation,
        warnings: observed.warnings,
        provenance: {
          source: 'radar',
          label: 'Observed DNS answer',
          matchStatus: comparison.matchStatus,
          differences: comparison.differences,
          method: predicted.method,
          expectsSubsetSelection: predicted.expectsSubsetSelection,
          distribution: predicted.distribution,
          predictedIps: predicted.answerIps,
          observedOrder: observed.answers.map((a) => a.address),
          representativeness: scenario.expectedRepresentativeness,
          predictedComplete: predicted.complete,
        },
        correlationId,
      });
    } catch (err) {
      this.logger.warn({ ispId: scenario.ispId, err: err instanceof Error ? err.name : 'error' }, 'dns-observation: persist failed');
      return undefined;
    }
  }

  // --- Optional periodic observation (off by default) ------------------------

  start(): void {
    if (this.timer || !this.config.periodic.enabled) return;
    this.running = true;
    const schedule = (delayMs: number): void => {
      this.timer = setTimeout(() => {
        void this.runCycle().finally(() => {
          if (this.running) schedule(this.nextDelayMs());
        });
      }, delayMs);
    };
    schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One automatic cycle: observe all scenarios with bounded concurrency and per-ISP
   *  isolation. Never throws. */
  async runCycle(): Promise<void> {
    try {
      const queue = [...this.scenarios];
      const worker = async (): Promise<void> => {
        for (;;) {
          const scenario = queue.shift();
          if (!scenario) return;
          try {
            await this.run(scenario.ispId);
          } catch (err) {
            // Per-ISP isolation: one failure never aborts the cycle.
            this.logger.warn({ ispId: scenario.ispId, err: err instanceof Error ? err.name : 'error' }, 'dns-observation: isp cycle failed');
          }
        }
      };
      const n = Math.max(1, Math.min(this.config.periodic.concurrency, this.scenarios.length));
      await Promise.all(Array.from({ length: n }, () => worker()));
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.warn({ failures: this.consecutiveFailures, err: err instanceof Error ? err.name : 'error' }, 'dns-observation: cycle failed');
    }
  }

  private nextDelayMs(): number {
    const base = this.config.periodic.minIntervalSeconds * 1000;
    if (this.consecutiveFailures === 0) return base;
    return Math.min(base * 2 ** this.consecutiveFailures, this.config.periodic.maxBackoffSeconds * 1000);
  }
}

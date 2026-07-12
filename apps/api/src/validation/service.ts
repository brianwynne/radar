// NS1 live-validation service. Fetches via the EXISTING read-only NS1 client only (GET-only;
// no write method, no arbitrary URL, no caller-supplied key/payload), preserves the complete
// raw response in memory for checksums/comparison, analyses it against the runtime schemas /
// adapter / fixtures, and persists a bounded, credential-redacted result. Running against a
// LIVE account is gated behind an explicit enable flag.
import type { Ns1ReadClient } from '../ns1/client.js';
import type { RadarMode } from '../ns1/config.js';
import { Ns1Error } from '../ns1/errors.js';
import { rawChecksum, structuralChecksum } from '../ns1/snapshot.js';
import type { NewValidationResult, ValidationResultRepository } from '@radar/data';
import { analyse } from './analysis.js';
import { redactDeep } from './redact.js';
import { buildFixtureCandidate } from './fixture.js';
import type { ValidationEndpoint, ValidationResult, ValidationRunRequest } from './types.js';

export interface ValidationServiceDeps {
  client: Ns1ReadClient;
  mode: RadarMode;
  liveValidationEnabled: boolean;
  repository?: ValidationResultRepository;
  now?: () => number;
}

export interface RunOptions {
  includeRaw?: boolean;
  canViewRaw?: boolean;
  correlationId?: string;
}

export class ValidationService {
  private readonly client: Ns1ReadClient;
  readonly mode: RadarMode;
  private readonly liveEnabled: boolean;
  private readonly repository?: ValidationResultRepository;
  private readonly now: () => number;

  constructor(deps: ValidationServiceDeps) {
    this.client = deps.client;
    this.mode = deps.mode;
    this.liveEnabled = deps.liveValidationEnabled;
    this.repository = deps.repository;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Reason live validation is blocked, or null when it may run. Mock mode is always allowed. */
  blockedReason(): string | null {
    return this.mode === 'live' && !this.liveEnabled ? 'LIVE_VALIDATION_DISABLED' : null;
  }

  async run(request: ValidationRunRequest, opts: RunOptions = {}): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const zone = request.zone;

    if (request.domain && request.recordType) {
      results.push(await this.validate('record', `${zone}/${request.domain}/${request.recordType}`, zone, request.domain, request.recordType, () => this.client.getRecord(zone, request.domain as string, request.recordType as string, opts.correlationId), opts));
    } else {
      results.push(await this.validate('zone', zone, zone, undefined, undefined, () => this.client.getZone(zone, opts.correlationId), opts));
    }

    if (request.includeActivity) {
      results.push(await this.validate('activity', 'account/activity', zone, undefined, undefined, () => this.client.getActivity({ limit: 50 }, opts.correlationId), opts));
    }

    return results;
  }

  private async validate(
    endpoint: ValidationEndpoint,
    resourceKey: string,
    zone: string | undefined,
    domain: string | undefined,
    recordType: string | undefined,
    fetchFn: () => Promise<unknown>,
    opts: RunOptions,
  ): Promise<ValidationResult> {
    const retrievedAt = new Date(this.now()).toISOString();

    let raw: unknown;
    try {
      raw = await fetchFn();
    } catch (err) {
      const code = err instanceof Ns1Error ? err.code : 'INTERNAL_ERROR';
      const result = this.unavailable(endpoint, resourceKey, zone, domain, recordType, retrievedAt, code);
      await this.persist(result, undefined, opts.correlationId);
      return result;
    }

    const rawC = rawChecksum(raw);
    const structC = structuralChecksum(raw);
    const analysis = analyse(endpoint, raw);
    const sanitised = redactDeep(raw); // always credential-redacted before storage/return

    const result: ValidationResult = {
      endpoint,
      resourceKey,
      zone,
      domain,
      recordType,
      sourceMode: this.mode,
      retrievedAt,
      rawChecksum: rawC,
      structuralChecksum: structC,
      ...analysis,
    };

    // Raw/fixture-candidate are returned only to a caller who asked AND holds ns1.raw.read.
    if (opts.includeRaw && opts.canViewRaw) {
      result.sanitisedSample = sanitised;
      result.fixtureCandidate = buildFixtureCandidate(raw, endpoint, resourceKey, this.mode, retrievedAt, rawC, analysis);
    }

    // Always persist the sanitised (redacted) sample; raw access is gated at read time.
    await this.persist(result, sanitised, opts.correlationId);
    return result;
  }

  private unavailable(endpoint: ValidationEndpoint, resourceKey: string, zone: string | undefined, domain: string | undefined, recordType: string | undefined, retrievedAt: string, code: string): ValidationResult {
    return {
      endpoint, resourceKey, zone, domain, recordType, sourceMode: this.mode, retrievedAt,
      rawChecksum: '', structuralChecksum: '',
      schemaCompatible: false, schemaIssues: [], adapterCompatible: false,
      supportedFilters: [], unsupportedFilters: [], unknownMetadataFields: [], unexpectedFields: [], missingExpectedFields: [],
      fieldTypeMismatches: [], unsupportedFeatures: [], answerGroupsPresent: false, feedControlledMetadataPresent: false,
      ecs: { present: false }, fixtureComparison: { provisionalFixtureFields: [], liveOnlyFields: [], typeMismatches: [], matches: true },
      warnings: [`Upstream fetch failed (${code}).`], overallStatus: 'unavailable',
    };
  }

  private async persist(result: ValidationResult, sanitisedSample: unknown, correlationId?: string): Promise<void> {
    if (!this.repository) return;
    const record: NewValidationResult = {
      ranAt: new Date(this.now()),
      endpoint: result.endpoint,
      zone: result.zone,
      domain: result.domain,
      recordType: result.recordType,
      sourceMode: result.sourceMode,
      retrievedAt: new Date(result.retrievedAt),
      rawChecksum: result.rawChecksum || undefined,
      structuralChecksum: result.structuralChecksum || undefined,
      overallStatus: result.overallStatus,
      schemaCompatible: result.schemaCompatible,
      adapterCompatible: result.adapterCompatible,
      supportedFilters: result.supportedFilters,
      unsupportedFilters: result.unsupportedFilters,
      unknownFields: { metadata: result.unknownMetadataFields, unexpected: result.unexpectedFields, features: result.unsupportedFeatures, schemaIssues: result.schemaIssues },
      missingFields: result.missingExpectedFields,
      typeMismatches: result.fieldTypeMismatches,
      answerGroupsPresent: result.answerGroupsPresent,
      feedControlledPresent: result.feedControlledMetadataPresent,
      ecs: result.ecs,
      fixtureComparison: result.fixtureComparison,
      warnings: result.warnings,
      sanitisedSample,
      correlationId,
    };
    try {
      await this.repository.create(record);
    } catch {
      // Persistence failure must not break a read-only validation run.
    }
  }
}

// Read-only NS1 production-readiness validation contract. Validation NEVER writes to NS1,
// never accepts a caller-supplied URL/key/payload, preserves the complete raw response for
// checksums/comparison (in memory only), and persists only credential-redacted, structural
// samples. It never silently coerces incompatible live data into the synthetic model — it
// reports the divergence instead.

export type OverallStatus = 'compatible' | 'compatible_with_warnings' | 'partial' | 'incompatible' | 'unavailable';

export type ValidationEndpoint = 'zones' | 'zone' | 'record' | 'activity';

export interface FieldTypeMismatch {
  path: string;
  expected: string;
  actual: string;
}

export interface UnsupportedFeature {
  kind: 'filter' | 'metadata' | 'structure';
  name: string;
  detail: string;
}

export interface EcsConfiguration {
  /** Whether a `use_client_subnet` field is present in the payload. */
  present: boolean;
  /** Its value when present. */
  enabled?: boolean;
}

export interface FixtureComparison {
  /** Fields the synthetic fixture defines that are ABSENT from the live payload (provisional
   *  guesses that do not match live NS1). */
  provisionalFixtureFields: string[];
  /** Fields present in live but absent from the fixture model. */
  liveOnlyFields: string[];
  /** Key paths whose value type differs between fixture and live. */
  typeMismatches: FieldTypeMismatch[];
  matches: boolean;
}

/** The parsed, bounded run request. Deliberately narrow — no URL/key/payload/write. */
export interface ValidationRunRequest {
  zone: string;
  domain?: string;
  recordType?: string;
  includeActivity?: boolean;
  includeRaw?: boolean;
}

export interface SanitisedFixtureCandidate {
  provenance: {
    source: 'ns1';
    mode: string;
    endpoint: ValidationEndpoint;
    resourceKey: string;
    retrievedAt: string;
    rawChecksum: string;
    generatedBy: 'radar-validation';
    warning: string;
    reviewRequired: string[];
  };
  /** Credential-redacted, order-preserving structural payload. Not a committed fixture. */
  payload: unknown;
}

export interface ValidationResult {
  endpoint: ValidationEndpoint;
  resourceKey: string;
  zone?: string;
  domain?: string;
  recordType?: string;
  sourceMode: string;
  retrievedAt: string;
  rawChecksum: string;
  structuralChecksum: string;
  schemaCompatible: boolean;
  schemaIssues: string[];
  adapterCompatible: boolean;
  supportedFilters: string[];
  unsupportedFilters: string[];
  unknownMetadataFields: string[];
  unexpectedFields: string[];
  missingExpectedFields: string[];
  fieldTypeMismatches: FieldTypeMismatch[];
  unsupportedFeatures: UnsupportedFeature[];
  answerGroupsPresent: boolean;
  feedControlledMetadataPresent: boolean;
  ecs: EcsConfiguration;
  fixtureComparison: FixtureComparison;
  warnings: string[];
  overallStatus: OverallStatus;
  /** Present only when the caller requested raw AND holds ns1.raw.read; always sanitised. */
  sanitisedSample?: unknown;
  /** Downloadable candidate (never auto-committed). */
  fixtureCandidate?: SanitisedFixtureCandidate;
}

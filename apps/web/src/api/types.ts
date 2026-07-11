// API contract types, mirroring the radar-api responses. The frontend consumes these; it
// never re-implements evaluation logic (that is @radar/engine, server-side).

export interface Principal {
  subject: string;
  displayName?: string;
  email?: string;
  roles: string[];
  permissions: string[];
  authenticationMethod: 'dev' | 'oidc';
  developmentAuthentication: boolean;
}

export interface Provenance {
  source: 'ns1';
  mode: 'mock' | 'live';
  synthetic: boolean;
  readOnly: true;
  endpoint: string;
  retrievedAt: string;
  disclaimer?: string;
}

export interface Ns1Status {
  mode: 'mock' | 'live';
  synthetic: boolean;
  readOnly: boolean;
  disclaimer?: string;
}

export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

export interface DerivedIdentity {
  source: 'ecs' | 'resolver';
  evaluatedAddress: string;
  country?: string;
  asn?: number;
  network?: string;
  prefix?: string;
  confidence: Confidence;
  notes: string[];
}

export interface TracedAnswer {
  id: string;
  label: string;
  deliveryPlatform?: string;
  rdata: string[];
  weight?: number;
  priority?: number;
  region?: string;
}

export type AnswerDisposition = 'retained' | 'removed' | 'reordered' | 'standby' | 'selected' | 'unsupported';

export interface AnswerOutcome {
  answerId: string;
  disposition: AnswerDisposition;
  reason: string;
}

export type FilterBehaviour = 'eliminate' | 'reorder' | 'select' | 'group' | 'modify' | 'unknown';

export interface FilterTrace {
  index: number;
  type: string;
  disabled: boolean;
  supported: boolean;
  behaviour: FilterBehaviour;
  config: Record<string, unknown>;
  metadataConsumed: string[];
  input: string[];
  output: string[];
  orderingBefore: string[];
  orderingAfter: string[];
  removedAnswerIds: string[];
  outcomes: AnswerOutcome[];
  reorder: boolean;
  reason: string;
  confidence: Confidence;
  warning?: string;
}

export interface ExpectedShare {
  answerId: string;
  label: string;
  deliveryPlatform?: string;
  share: number;
}

export interface ExpectedDistribution {
  probabilistic: true;
  method: 'weighted_shuffle' | 'uniform_shuffle' | 'single_answer';
  shares: ExpectedShare[];
  disclaimers: string[];
}

export interface Scenario {
  qname: string;
  qtype: string;
  resolverIp: string;
  ecsPresent: boolean;
  ecsPrefix?: string;
  country?: string;
  asn?: number;
  network?: string;
  clientPrefix?: string;
  healthOverrides?: Record<string, boolean>;
}

export interface EvaluationResult {
  scenario: Scenario;
  identity: DerivedIdentity;
  answers: TracedAnswer[];
  traces: FilterTrace[];
  eligibleAnswerIds: string[];
  selected?: string;
  expectedDistribution?: ExpectedDistribution;
  complete: boolean;
  stoppedAtFilterIndex?: number;
  explanation: string;
  warnings: string[];
  unsupportedFilters: string[];
}

export interface ExplainRequest {
  zone: string;
  domain: string;
  type: string;
  scenario: Omit<Scenario, 'qname' | 'qtype'>;
}

export interface ExplainResponse {
  provenance: Provenance;
  request: { zone: string; domain: string; type: string; scenario: Scenario };
  evaluation: EvaluationResult;
}

export interface ZonesResponse {
  provenance: Provenance;
  zones: unknown[];
}

export interface ZoneResponse {
  provenance: Provenance;
  zone: Record<string, unknown>;
}

export interface RecordResponse {
  provenance: Provenance;
  record: Record<string, unknown>;
}

export interface RawRecordResponse {
  provenance: Provenance;
  raw: Record<string, unknown>;
}

export interface ActivityItem {
  id?: string;
  occurredAt?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  resourceKey?: string;
  outcome?: string;
  detail?: string;
  raw: Record<string, unknown>;
}

export interface ActivityResponse {
  provenance: Provenance;
  mappingNote: string;
  count: number;
  items: ActivityItem[];
}

export interface SnapshotMetadata {
  mode?: string;
  synthetic?: boolean;
  warnings?: string[];
  [k: string]: unknown;
}

export interface SnapshotSummary {
  id: string;
  sourceSystem: string;
  resourceKind: string;
  resourceKey: string;
  sourceEndpoint?: string;
  retrievedAt: string;
  createdAt: string;
  createdBySubject?: string;
  label?: string;
  rawChecksum: string;
  structuralChecksum?: string;
  metadata: SnapshotMetadata;
}

export interface SnapshotDetail extends SnapshotSummary {
  rawPayload: unknown;
  canonicalPayload: unknown;
}

export interface SnapshotHistory {
  count: number;
  snapshots: SnapshotSummary[];
}

export interface SnapshotCaptureResponse {
  provenance: Provenance;
  snapshot: SnapshotDetail;
}

export interface JsonDiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface CompareResponse {
  a: SnapshotSummary;
  b: SnapshotSummary;
  identical: boolean;
  diffCount: number;
  diff: JsonDiffEntry[];
}

export interface RecordDiffSummary {
  ttlChanged: boolean;
  ecsChanged: boolean;
  answersAdded: number;
  answersRemoved: number;
  answersChanged: number;
  filtersAdded: number;
  filtersRemoved: number;
  filtersChanged: number;
  filtersReordered: boolean;
  otherChanges: number;
}

export interface CompareCurrentResponse {
  snapshot: {
    id: string;
    label?: string;
    capturedAt: string;
    retrievedAt: string;
    sourceMode: string | null;
    synthetic: boolean;
    rawChecksum: string;
    structuralChecksum?: string;
  };
  current: {
    retrievedAt: string;
    sourceMode: string;
    synthetic: boolean;
    rawChecksum: string;
    structuralChecksum: string;
  };
  rawChecksumEqual: boolean;
  structuralChecksumEqual: boolean;
  identical: boolean;
  summary: RecordDiffSummary;
  changes: JsonDiffEntry[];
  warnings: string[];
  provenance: Provenance;
}

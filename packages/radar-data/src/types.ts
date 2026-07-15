// Framework-independent persistence contracts. This package depends on no HTTP or web
// framework and on no specific PostgreSQL client: it talks to any driver that satisfies
// the minimal `Queryable` below (node-pg's Pool/PoolClient and pg-mem both do). RADAR v1
// is read-only towards NS1; these tables store RADAR's own captured snapshots and audit
// trail, never a write path back to NS1.

/** Minimal query surface shared by node-pg (Pool/PoolClient) and pg-mem. */
export interface QueryResultLike<R> {
  rows: R[];
  rowCount?: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

// --- Configuration snapshots -------------------------------------------------

/** An immutable capture of an upstream configuration resource (e.g. an NS1 zone or
 *  record) exactly as retrieved, plus a canonicalised form and integrity checksums.
 *  The raw payload is preserved verbatim (ADR-0001); nothing is stored on the filesystem
 *  or in blob storage — payloads live in the row as JSONB. */
export interface NewSnapshot {
  /** Origin of the configuration, e.g. `ns1`. */
  sourceSystem: string;
  /** Kind of resource, e.g. `zone`, `record`. */
  resourceKind: string;
  /** Natural key within the source, e.g. `rte.ie` or `live.rte.ie/A`. */
  resourceKey: string;
  /** Read-only endpoint the payload came from (no credentials). */
  sourceEndpoint?: string;
  /** When the upstream resource was retrieved. */
  retrievedAt: Date;
  /** Authenticated subject that captured the snapshot (audit linkage). */
  createdBySubject?: string;
  /** Optional human label. */
  label?: string;
  /** Verbatim upstream payload. */
  rawPayload: unknown;
  /** Canonicalised payload used for comparison/explanation. */
  canonicalPayload: unknown;
  /** Checksum of the raw payload (integrity + dedupe support). */
  rawChecksum: string;
  /** Checksum of structurally-significant fields (change detection). */
  structuralChecksum?: string;
  /** Free-form, non-sensitive capture metadata. */
  metadata?: Record<string, unknown>;
}

export interface ConfigurationSnapshot extends NewSnapshot {
  id: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export interface SnapshotQuery {
  resourceKind?: string;
  resourceKey?: string;
  sourceSystem?: string;
  /** Filter by exact raw-payload checksum. */
  rawChecksum?: string;
  /** Only snapshots retrieved at or after this instant. */
  retrievedSince?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

// --- Audit events ------------------------------------------------------------

/** A security/operational audit record. `details` MUST NOT contain tokens, NS1 API
 *  keys, database credentials, or complete sensitive headers — callers are responsible
 *  for redaction before persistence. */
export interface NewAuditEvent {
  actorSubject?: string;
  actorRoles?: string[];
  authenticationMethod?: string;
  action: string;
  resourceType?: string;
  resourceKey?: string;
  outcome: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEvent extends NewAuditEvent {
  id: string;
  occurredAt: Date;
  actorRoles: string[];
  details: Record<string, unknown>;
}

// --- Change-detection checkpoint --------------------------------------------

export interface CheckpointRecord {
  source: string;
  checkpointId?: string;
  checkpointOccurredAt?: Date;
  updatedAt: Date;
}

export interface CheckpointRepository {
  get(source: string): Promise<CheckpointRecord | null>;
  upsert(source: string, checkpointId: string | undefined, checkpointOccurredAt: Date | undefined): Promise<void>;
}

// --- Live steering state & events -------------------------------------------

export interface SteeringDistributionShare {
  answerId: string;
  label: string;
  deliveryPlatform?: string;
  share: number;
}

export interface SteeringState {
  ispId: string;
  resourceKey: string;
  ispName: string;
  asn?: number;
  fingerprint: string;
  identitySource?: string;
  country?: string;
  matchedPrefix?: string;
  preferredPath?: string;
  eligibleAnswerIds: string[];
  distribution: SteeringDistributionShare[];
  filterChain: string[];
  complete: boolean;
  stoppedAtFilterIndex?: number;
  structuralChecksum?: string;
  evaluatedAt: Date;
  updatedAt: Date;
}

export type NewSteeringState = Omit<SteeringState, 'updatedAt'>;

export interface SteeringStateQuery {
  ispId?: string;
  asn?: number;
  resourceKey?: string;
}

export interface SteeringStateRepository {
  upsert(state: NewSteeringState): Promise<void>;
  get(ispId: string, resourceKey: string): Promise<SteeringState | null>;
  list(query?: SteeringStateQuery): Promise<SteeringState[]>;
}

export interface SteeringChangeEvent {
  id: string;
  occurredAt: Date;
  ispId: string;
  ispName: string;
  asn?: number;
  resourceKey: string;
  reason: string;
  previousFingerprint?: string;
  currentFingerprint: string;
  previousState?: unknown;
  currentState: unknown;
  previousChecksum?: string;
  currentChecksum?: string;
  activity: Record<string, unknown>;
}

export type NewSteeringChangeEvent = Omit<SteeringChangeEvent, 'id' | 'occurredAt'> & { occurredAt?: Date };

export interface SteeringEventQuery {
  ispId?: string;
  asn?: number;
  resourceKey?: string;
  /** Events strictly after this instant. */
  since?: Date;
  /** Events at or before this instant. */
  before?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

export interface SteeringEventRepository {
  create(event: NewSteeringChangeEvent): Promise<SteeringChangeEvent>;
  list(query?: SteeringEventQuery): Promise<SteeringChangeEvent[]>;
}

// --- DNS observations (Tier-2 active DNS probing history) --------------------

/** A bounded-history record of one active DNS observation and its comparison against
 *  RADAR's predicted NS1 evaluation. Read-only-derived; stores no credentials, packet
 *  captures or raw resolver logs. `observedAnswers`/`predictedAnswers`/`warnings`/
 *  `provenance` are opaque JSONB to this layer. */
export interface DnsObservationRecord {
  id: string;
  observedAt: Date;
  ispId: string;
  ispName: string;
  asn?: number;
  resolverIp?: string;
  zone: string;
  domain: string;
  recordType: string;
  ecsRequested: boolean;
  ecsPrefix?: string;
  ecsHonoured?: boolean;
  responseCode?: string;
  observedAnswers: unknown;
  predictedAnswers: unknown;
  comparisonStatus: string;
  confidence: string;
  ttl?: number;
  latencyMs?: number;
  recordChecksum?: string;
  explanation?: string;
  warnings: unknown;
  provenance: unknown;
  correlationId?: string;
}

export type NewDnsObservation = Omit<DnsObservationRecord, 'id' | 'observedAt'> & { observedAt?: Date };

export interface DnsObservationQuery {
  ispId?: string;
  resolverIp?: string;
  zone?: string;
  domain?: string;
  recordType?: string;
  comparisonStatus?: string;
  recordChecksum?: string;
  since?: Date;
  before?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

export interface DnsObservationRepository {
  create(observation: NewDnsObservation): Promise<DnsObservationRecord>;
  list(query?: DnsObservationQuery): Promise<DnsObservationRecord[]>;
  /** The latest observation per ISP (the current observed-DNS state). */
  latestPerIsp(): Promise<DnsObservationRecord[]>;
}

// --- NS1 live-validation results (bounded history) --------------------------

/** A bounded-history record of one read-only NS1 production-readiness validation. Stores no
 *  credentials or raw secrets; `sanitisedSample` is credential-redacted and structural. The
 *  JSONB fields are opaque to this layer. */
export interface ValidationResultRecord {
  id: string;
  ranAt: Date;
  endpoint: string;
  zone?: string;
  domain?: string;
  recordType?: string;
  sourceMode: string;
  retrievedAt?: Date;
  rawChecksum?: string;
  structuralChecksum?: string;
  overallStatus: string;
  schemaCompatible: boolean;
  adapterCompatible: boolean;
  supportedFilters: unknown;
  unsupportedFilters: unknown;
  unknownFields: unknown;
  missingFields: unknown;
  typeMismatches: unknown;
  answerGroupsPresent: boolean;
  feedControlledPresent: boolean;
  ecs: unknown;
  fixtureComparison: unknown;
  warnings: unknown;
  sanitisedSample?: unknown;
  correlationId?: string;
}

export type NewValidationResult = Omit<ValidationResultRecord, 'id' | 'ranAt'> & { ranAt?: Date };

export interface ValidationResultQuery {
  zone?: string;
  domain?: string;
  recordType?: string;
  endpoint?: string;
  overallStatus?: string;
  rawChecksum?: string;
  since?: Date;
  before?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

export interface ValidationResultRepository {
  create(result: NewValidationResult): Promise<ValidationResultRecord>;
  getById(id: string): Promise<ValidationResultRecord | null>;
  list(query?: ValidationResultQuery): Promise<ValidationResultRecord[]>;
}

export interface AuditQuery {
  actorSubject?: string;
  action?: string;
  resourceType?: string;
  resourceKey?: string;
  outcome?: string;
  correlationId?: string;
  /** Only events at or after this instant. */
  occurredAfter?: Date;
  /** Only events at or before this instant. */
  occurredBefore?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

// --- Connector settings (Engineer-managed; secret token stored encrypted) -----------------

/** A persisted connector-settings row. The token is present ONLY as opaque encrypted
 *  material (never plaintext); non-secret fields are stored in the clear. */
export interface ConnectorSettingsRecord {
  connector: string;
  enabled: boolean;
  mode: string;
  endpoint: string | null;
  verifyTls: boolean;
  edgeDeviceIds: string | null;
  tokenCiphertext: Buffer | null;
  tokenNonce: Buffer | null;
  tokenTag: Buffer | null;
  tokenSetAt: Date | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** What the repository does with the token on an update. `retain` leaves the stored token
 *  untouched; `replace` writes the supplied ciphertext; `clear` removes it. */
export type TokenAction = 'retain' | 'replace' | 'clear';

export interface ConnectorSettingsUpdate {
  connector: string;
  enabled: boolean;
  mode: string;
  endpoint: string | null;
  verifyTls: boolean;
  edgeDeviceIds: string | null;
  updatedBy: string | null;
  tokenAction: TokenAction;
  /** Present only when tokenAction === 'replace'. Opaque ciphertext, never plaintext. */
  tokenCiphertext?: Buffer | null;
  tokenNonce?: Buffer | null;
  tokenTag?: Buffer | null;
}

export interface ConnectorSettingsRepository {
  get(connector: string): Promise<ConnectorSettingsRecord | null>;
  upsert(update: ConnectorSettingsUpdate): Promise<ConnectorSettingsRecord>;
}

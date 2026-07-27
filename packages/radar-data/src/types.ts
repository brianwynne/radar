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

// --- PNI bandwidth history (time-series for the PNI Graphs page) -------------

/** One top-level link's in/out bandwidth at a poll. Numeric rates + labels only. Every link is
 *  logged (not just eyeball PNIs) for fault-finding; `linkType` + `datacentre` let the UI classify
 *  eyeball networks and tag each with its Citywest/Parkwest identity. */
export interface NewPniBandwidthSample {
  deviceId: string;
  interfaceName: string;
  provider: string | null;
  linkType: string | null;
  datacentre: string | null;
  inBps: number | null;
  outBps: number | null;
}

/** A bandwidth point for one link (from `range`, possibly time-bucketed/averaged). */
export interface PniBandwidthPoint {
  deviceId: string;
  interfaceName: string;
  provider: string | null;
  linkType: string | null;
  datacentre: string | null;
  at: Date;
  inBps: number | null;
  outBps: number | null;
}

export interface PniBandwidthRangeQuery {
  /** Inclusive lower bound. */
  since: Date;
  /** Inclusive upper bound (default: now). */
  until?: Date;
  /** Downsample width (seconds); in/out are averaged per interface per bucket so the chart
   *  renders a bounded number of points regardless of range. */
  bucketSeconds: number;
}

/** Append-only, bounded per-PNI bandwidth history. Writes come from the CloudVision poll;
 *  reads drive the PNI Graphs time-series. Old rows are pruned past the retention horizon. */
export interface PniBandwidthRepository {
  /** Insert a batch of samples all stamped with the same capture time. Returns rows written. */
  insertBatch(at: Date, samples: NewPniBandwidthSample[]): Promise<number>;
  /** Bucketed range, ordered by interface then time ascending. */
  range(query: PniBandwidthRangeQuery): Promise<PniBandwidthPoint[]>;
  /** Delete samples older than the cutoff. Returns rows removed. */
  prune(olderThan: Date): Promise<number>;
}

// --- RIS Live BGP events (bounded history) ----------------------------------

/** One RIS Live BGP event cluster to persist (announcement or withdrawal for a monitored prefix). */
export interface NewRisEvent {
  id: string;
  kind: 'announcement' | 'withdrawal';
  prefix: string;
  originAsn: number | null;
  peerAsn: number | null;
  /** AS path (empty for a withdrawal). */
  path: number[];
  observationCount: number;
  firstAt: Date;
  lastAt: Date;
}

/** A persisted RIS Live BGP event (from `range`). */
export interface RisEventRecord extends NewRisEvent {}

export interface RisEventQuery {
  /** Inclusive lower bound (on the cluster's most-recent observation). */
  since: Date;
  /** Inclusive upper bound (default: now). */
  until?: Date;
  prefix?: string;
  kind?: 'announcement' | 'withdrawal';
  /** Newest-first cap (default 500). */
  limit?: number;
}

/** A RIS Live connection state transition — so a collector gap is visible, not silent. */
export interface RisConnectionChange {
  at: Date;
  state: string;
  detail: string | null;
}

/** Bounded RIS Live event history. Writes come from a periodic drain of the in-memory RIS buffer;
 *  reads drive the BGP Intelligence timeline over a retention window. Old rows are pruned. */
export interface RisEventRepository {
  /** Upsert a batch of event clusters (idempotent on id; keeps the latest observation state). */
  upsertBatch(events: NewRisEvent[]): Promise<number>;
  /** Newest-first events within the window (optionally filtered by prefix/kind). */
  range(query: RisEventQuery): Promise<RisEventRecord[]>;
  /** Record a RIS connection state change (idempotent on the instant). */
  recordConnectionState(change: RisConnectionChange): Promise<void>;
  /** Newest-first connection transitions within the window. */
  connectionChanges(query: { since: Date; until?: Date; limit?: number }): Promise<RisConnectionChange[]>;
  /** Delete events and connection transitions older than the cutoff. Returns rows removed. */
  prune(olderThan: Date): Promise<number>;
}

// --- Delivery totals (bounded history for the Dashboard pie's hourly average) ----

/** One periodic sample of total live delivery, split Réalta (eyeball) vs commercial CDNs. */
export interface NewDeliverySample {
  at: Date;
  realtaBps: number;
  commercialBps: number;
  totalBps: number;
}

/** Averages over a window (nulls when no samples in range). */
export interface DeliveryAverages {
  avgRealtaBps: number | null;
  avgCommercialBps: number | null;
  avgTotalBps: number | null;
  sampleCount: number;
}

export interface DeliverySampleRepository {
  /** Insert one sample (idempotent on the instant). */
  insert(sample: NewDeliverySample): Promise<void>;
  /** Averages over all samples at or after `since`. */
  averageSince(since: Date): Promise<DeliveryAverages>;
  /** Delete samples older than the cutoff. Returns rows removed. */
  prune(olderThan: Date): Promise<number>;
}

// --- Stream Assurance (profiles + bounded run snapshots) --------------------

/** Operator-defined channel + endpoint configuration. `config` is app-shaped jsonb (no secrets). */
export interface StreamAssuranceProfileRow {
  id: string;
  name: string;
  config: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export interface NewStreamAssuranceProfile {
  id: string;
  name: string;
  config: unknown;
  enabled?: boolean;
}

/** A bounded snapshot of one probe run: per-endpoint observations + classified findings. */
export interface StreamAssuranceRunRow {
  id: string;
  profileId: string;
  startedAt: Date;
  finishedAt: Date | null;
  mode: string;
  status: string;
  observations: unknown;
  findings: unknown;
  findingCount: number;
}
export interface NewStreamAssuranceRun {
  id: string;
  profileId: string;
  startedAt: Date;
  finishedAt: Date | null;
  mode: string;
  status: string;
  observations: unknown;
  findings: unknown;
  findingCount: number;
}

/** A durable alert with lifecycle state, keyed by finding identity across runs. */
export interface StreamAlertRow {
  id: string;
  profileId: string;
  endpointId: string;
  ruleId: string;
  classification: string;
  severity: string;
  state: string;
  consecutivePresent: number;
  consecutiveAbsent: number;
  occurrences: number;
  firstObserved: Date;
  lastObserved: Date;
  explanation: string | null;
  remediation: string | null;
  evidence: unknown;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  updatedAt: Date;
}
export interface UpsertStreamAlert {
  id: string;
  profileId: string;
  endpointId: string;
  ruleId: string;
  classification: string;
  severity: string;
  state: string;
  consecutivePresent: number;
  consecutiveAbsent: number;
  occurrences: number;
  firstObserved: Date;
  lastObserved: Date;
  explanation: string | null;
  remediation: string | null;
  evidence: unknown;
  updatedAt: Date;
}

export interface StreamAssuranceRepository {
  upsertProfile(p: NewStreamAssuranceProfile): Promise<void>;
  listProfiles(): Promise<StreamAssuranceProfileRow[]>;
  getProfile(id: string): Promise<StreamAssuranceProfileRow | null>;
  deleteProfile(id: string): Promise<void>;
  insertRun(r: NewStreamAssuranceRun): Promise<void>;
  latestRun(profileId: string): Promise<StreamAssuranceRunRow | null>;
  listRuns(profileId: string, limit?: number): Promise<StreamAssuranceRunRow[]>;
  pruneRuns(olderThan: Date): Promise<number>;
  // Alert lifecycle
  listAlertsByProfile(profileId: string): Promise<StreamAlertRow[]>;
  listOpenAlerts(profileId?: string): Promise<StreamAlertRow[]>;
  getAlert(id: string): Promise<StreamAlertRow | null>;
  upsertAlert(a: UpsertStreamAlert): Promise<void>;
  acknowledgeAlert(id: string, by: string): Promise<StreamAlertRow | null>;
  resolveAlert(id: string): Promise<StreamAlertRow | null>;
  pruneAlerts(olderThan: Date): Promise<number>;
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

// --- bgp.tools routing intelligence (read-only) -----------------------------

export type BgpToolsAddressFamily = 'ipv4' | 'ipv6';

/** One monitored prefix and the origin ASN it is expected to be announced from. */
export interface MonitoredPrefixRecord {
  prefix: string;
  addressFamily: BgpToolsAddressFamily;
  expectedOriginAsn: number;
  description?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MonitoredPrefixUpsert = Omit<MonitoredPrefixRecord, 'createdAt' | 'updatedAt'>;

export interface BgpToolsMonitoredPrefixRepository {
  list(): Promise<MonitoredPrefixRecord[]>;
  upsert(prefix: MonitoredPrefixUpsert): Promise<MonitoredPrefixRecord>;
  remove(prefix: string): Promise<boolean>;
}

/** A single observed origin for a prefix (from the bgp.tools table), with its visibility hits. */
export interface ObservedOriginRecord {
  asn: number;
  hits: number;
}

/** A raw table observation for one prefix, recorded only when the origin set changes. */
export interface BgpToolsObservationRecord {
  id: string;
  prefix: string;
  addressFamily: BgpToolsAddressFamily;
  origins: ObservedOriginRecord[];
  contentChecksum: string;
  observedAt: Date;
  source: string;
  createdAt: Date;
}

export type NewBgpToolsObservation = Omit<BgpToolsObservationRecord, 'id' | 'createdAt' | 'contentChecksum'> & {
  /** Optional precomputed checksum; the repository derives one from `origins` when absent. */
  contentChecksum?: string;
};

export interface BgpToolsObservationQuery {
  prefix?: string;
  since?: Date;
  /** Page size, 1..1000 (default 200). */
  limit?: number;
}

export interface BgpToolsObservationRepository {
  /** Record an observation only if the origin set differs from the latest for that prefix
   *  (change-log semantics). Returns the stored record, or the existing latest when unchanged. */
  record(observation: NewBgpToolsObservation): Promise<{ record: BgpToolsObservationRecord; inserted: boolean }>;
  list(query?: BgpToolsObservationQuery): Promise<BgpToolsObservationRecord[]>;
  /** Delete observations older than the cutoff; returns the number removed. */
  prune(olderThan: Date): Promise<number>;
}

export type IncidentKind = 'withdrawn' | 'hijack' | 'moas' | 'visibility_loss' | 'missing_upstream' | 'new_upstream';
export type IncidentSeverity = 'degraded' | 'critical';
export type IncidentState = 'detected' | 'active' | 'acknowledged' | 'resolved' | 'suppressed';

export interface BgpToolsIncidentRecord {
  id: string;
  prefix: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  state: IncidentState;
  firstDetectedAt: Date;
  lastObservedAt: Date;
  resolvedAt?: Date;
  observationCount: number;
  evidence: unknown;
  updatedAt: Date;
}

/** An observed problem for a prefix at a point in time — drives open-or-update grouping. */
export interface IncidentSignal {
  prefix: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  observedAt: Date;
  evidence: unknown;
}

export interface BgpToolsIncidentQuery {
  state?: IncidentState;
  prefix?: string;
  /** When true, only open incidents (detected/active/acknowledged). */
  openOnly?: boolean;
  limit?: number;
}

export interface BgpToolsIncidentRepository {
  /** Open a new incident for (prefix, kind) or update the existing open one (bumps count,
   *  last-observed, severity, evidence). Idempotent grouping. */
  openOrUpdate(signal: IncidentSignal): Promise<BgpToolsIncidentRecord>;
  /** Resolve any open incident for (prefix, kind); returns the resolved record if one existed. */
  resolveOpen(prefix: string, kind: IncidentKind, at: Date): Promise<BgpToolsIncidentRecord | null>;
  list(query?: BgpToolsIncidentQuery): Promise<BgpToolsIncidentRecord[]>;
}

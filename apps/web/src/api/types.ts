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
  /** Retained only as an untagged fallback (nothing matched / no restriction) — highlight it. */
  fallback?: boolean;
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

export type SelectionDeterminism = 'deterministic' | 'context_dependent' | 'probabilistic' | 'partial';

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
  selectionDeterminism: SelectionDeterminism;
  expectedDistribution?: ExpectedDistribution;
  complete: boolean;
  stoppedAtFilterIndex?: number;
  explanation: string;
  warnings: string[];
  unsupportedFilters: string[];
  metadataConfigured: string[];
  metadataConsumed: string[];
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

export interface Ns1ActiveRecordResponse {
  provenance: Provenance;
  /** The public entry domain resolved to find the active record (e.g. live.rte.ie). */
  entry: string;
  /** The entry's current CNAME target (the active record's FQDN), or null if unresolved. */
  target: string | null;
  /** The active steering record, or null when it can't be resolved/read. */
  active: { zone: string; domain: string; type: string } | null;
  filterCount: number | null;
  warnings: string[];
}

export interface AsnTag {
  answerId: string | null;
  note: string | null;
  platform: string | null;
  weight: number | null;
}

export interface AsnBreakdownRow {
  asn: number;
  holder: string | null;
  resolved: boolean;
  tags: AsnTag[];
}

export interface AsnAnswerGroup {
  answerId: string | null;
  note: string | null;
  platform: string | null;
  weight: number | null;
  target: string;
  asnCount: number;
  networks: { asn: number; holder: string | null }[];
}

export interface AsnBreakdownResponse {
  provenance: Provenance;
  record: { zone: string; domain: string; type: string };
  source: string;
  asnCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  answers: AsnAnswerGroup[];
  rows: AsnBreakdownRow[];
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

export interface AuditEventItem {
  id: string;
  occurredAt: string;
  actorSubject?: string;
  actorRoles: string[];
  authenticationMethod?: string;
  action: string;
  resourceType?: string;
  resourceKey?: string;
  outcome: string;
  correlationId?: string;
  details: Record<string, unknown>;
}

export interface AuditListResponse {
  provenance: { source: string; readOnly: boolean; retrievedAt: string };
  count: number;
  items: AuditEventItem[];
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
    resourceKey?: string;
    capturedAt: string;
    retrievedAt: string;
    sourceMode: string | null;
    synthetic: boolean;
    rawChecksum: string;
    structuralChecksum?: string;
  };
  current: {
    resourceKey?: string;
    retrievedAt: string;
    sourceMode: string;
    synthetic: boolean;
    rawChecksum: string;
    structuralChecksum: string;
  };
  /** The NS1 record the snapshot was compared against (own record unless a target was given). */
  target?: { zone: string; domain: string; type: string };
  /** True when the current record is a DIFFERENT record than the snapshot's own. */
  crossRecord?: boolean;
  rawChecksumEqual: boolean;
  structuralChecksumEqual: boolean;
  identical: boolean;
  summary: RecordDiffSummary;
  changes: JsonDiffEntry[];
  warnings: string[];
  provenance: Provenance;
}

// --- Live Steering (persisted state & events) --------------------------------

export interface LiveSteeringProvenance {
  source: 'radar';
  readOnly: true;
  label: string;
  retrievedAt: string;
}

export interface LiveSteeringIsp {
  id: string;
  name: string;
  asn: number;
  ecsPrefix: string;
  preferredPath: string;
}

export interface LiveSteeringRecord {
  zone: string;
  domain: string;
  type: string;
  resourceKey: string;
}

export interface LiveSteeringReason {
  id: string;
  label: string;
}

export interface LiveSteeringConfig {
  provenance: LiveSteeringProvenance;
  maxSelectableIsps: number;
  pollIntervalsSeconds: number[];
  defaultPollIntervalSeconds: number;
  highlightSeconds: number;
  isps: LiveSteeringIsp[];
  records: LiveSteeringRecord[];
  reasons: LiveSteeringReason[];
}

export interface SteeringDistributionShare {
  answerId: string;
  label: string;
  deliveryPlatform?: string;
  share: number;
}

export interface LiveSteeringState {
  ispId: string;
  ispName: string;
  asn?: number;
  resourceKey: string;
  identitySource?: string;
  country?: string;
  matchedPrefix?: string;
  preferredPath?: string;
  eligibleAnswerIds: string[];
  distribution: SteeringDistributionShare[];
  filterChain: string[];
  complete: boolean;
  stoppedAtFilterIndex?: number;
  fingerprint: string;
  structuralChecksum?: string;
  evaluatedAt: string;
  updatedAt: string;
}

export interface LiveSteeringStateResponse {
  provenance: LiveSteeringProvenance;
  count: number;
  items: LiveSteeringState[];
}

export interface LiveSteeringEvent {
  id: string;
  occurredAt: string;
  ispId: string;
  ispName: string;
  asn?: number;
  resourceKey: string;
  reason: string;
  reasonLabel: string;
  previousFingerprint?: string;
  currentFingerprint: string;
  previousChecksum?: string;
  currentChecksum?: string;
  previousState?: LiveSteeringState | null;
  currentState: LiveSteeringState;
  activity: Record<string, unknown>;
}

export interface LiveSteeringEventsResponse {
  provenance: LiveSteeringProvenance;
  count: number;
  items: LiveSteeringEvent[];
}

// --- Network-path telemetry (read-only, informational) -----------------------

export type PathType = 'PNI' | 'INEX' | 'transit';
export type TelemetrySource = 'mock' | 'prometheus' | 'disabled';
export type TelemetryStatus =
  | 'healthy'
  | 'above_target'
  | 'warning'
  | 'critical'
  | 'unavailable'
  | 'stale'
  | 'telemetry_not_connected';

export interface TelemetryFreshness {
  ageSeconds: number | null;
  staleAfterSeconds: number;
  fresh: boolean;
}

export interface TelemetrySampleProvenance {
  source: TelemetrySource;
  synthetic: boolean;
  readOnly: true;
  informationalOnly: true;
  note: string;
}

export interface NetworkPathSample {
  pathId: string;
  pathName: string;
  pathType: PathType;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  configuredCapacityBps: number;
  configuredTargetPercent: number;
  observedInboundBps: number | null;
  observedOutboundBps: number | null;
  observedUtilisationPercent: number | null;
  observedAt: string | null;
  source: TelemetrySource;
  provenance: TelemetrySampleProvenance;
  // Engineering detail (present only with ns1.detail.read).
  interfaceIdentity?: string;
  direction?: 'inbound' | 'outbound';
  warningThresholdPercent?: number;
  criticalThresholdPercent?: number;
  warnings?: string[];
}

export interface TelemetryProvenance {
  source: 'radar';
  telemetryMode: TelemetrySource;
  readOnly: true;
  informationalOnly: true;
  notice: string;
  retrievedAt: string;
}

export interface NetworkPathsResponse {
  provenance: TelemetryProvenance;
  count: number;
  items: NetworkPathSample[];
}

export interface NetworkPathResponse {
  provenance: TelemetryProvenance;
  item: NetworkPathSample;
}

// --- Cache-pool / cache-node / origin telemetry (read-only, informational) ---

export interface CachePoolSample {
  poolId: string;
  poolName: string;
  site: string;
  cacheNodeCount: number;
  configuredCapacityBps: number;
  observedOutboundBps: number | null;
  observedUtilisationPercent: number | null;
  headroomBps: number | null;
  cpuUtilisationPercent: number | null;
  memoryUtilisationPercent: number | null;
  cacheHitRatio: number | null;
  requestRate: number | null;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  observedAt: string | null;
  source: TelemetrySource;
  provenance: TelemetrySampleProvenance;
  // Engineering detail (with ns1.detail.read):
  targetPercent?: number;
  warningPercent?: number;
  criticalPercent?: number;
  warnings?: string[];
}

export interface CacheNodeSample {
  nodeId: string;
  nodeName: string;
  poolId: string;
  site: string;
  configuredCapacityBps: number;
  observedOutboundBps: number | null;
  observedUtilisationPercent: number | null;
  headroomBps: number | null;
  cpuUtilisationPercent: number | null;
  memoryUtilisationPercent: number | null;
  cacheHitRatio: number | null;
  requestRate: number | null;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  observedAt: string | null;
  source: TelemetrySource;
  provenance: TelemetrySampleProvenance;
  targetPercent?: number;
  warningPercent?: number;
  criticalPercent?: number;
  warnings?: string[];
}

export interface OriginSample {
  originId: string;
  originName: string;
  requestRate: number | null;
  outboundBandwidthBps: number | null;
  cpuUtilisationPercent: number | null;
  status: TelemetryStatus;
  stale: boolean;
  freshness: TelemetryFreshness;
  observedAt: string | null;
  source: TelemetrySource;
  provenance: TelemetrySampleProvenance;
  warnings?: string[];
}

export interface CachePoolsResponse {
  provenance: TelemetryProvenance;
  count: number;
  items: CachePoolSample[];
}
export interface CachePoolResponse {
  provenance: TelemetryProvenance;
  item: CachePoolSample;
}
export interface CacheNodesResponse {
  provenance: TelemetryProvenance;
  count: number;
  items: CacheNodeSample[];
}
export interface CacheNodeResponse {
  provenance: TelemetryProvenance;
  item: CacheNodeSample;
}
export interface OriginResponse {
  provenance: TelemetryProvenance;
  item: OriginSample;
}

// --- DNS observation (Tier-2 predicted-vs-observed) --------------------------

export type DnsComparisonStatus = 'match' | 'partial_match' | 'mismatch' | 'observation_unavailable' | 'confidence_low' | 'unknown';
export type DnsConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface DnsObservationScenarioConfig {
  ispId: string;
  ispName: string;
  asn: number;
  country: string;
  resolvers: string[];
  ecsSubnet?: string;
  zone: string;
  domain: string;
  recordType: string;
  expectedRepresentativeness: 'high' | 'medium' | 'low';
  provenance: string;
  notes: string;
}

export interface DnsTierLabels {
  predicted: string;
  observed: string;
  traffic: string;
}

export interface DnsObservationConfigResponse {
  provenance: { source: 'radar'; readOnly: true; retrievedAt: string };
  mode: 'disabled' | 'mock' | 'resolver';
  staleAfterSeconds: number;
  tierLabels: DnsTierLabels;
  comparisonStatuses: DnsComparisonStatus[];
  confidenceLevels: DnsConfidence[];
  scenarios: DnsObservationScenarioConfig[];
}

export interface DnsObservationDifference {
  kind: string;
  detail: string;
}

export interface DnsObservationItem {
  id: string;
  observedAt: string;
  freshness: { ageSeconds: number | null; staleAfterSeconds: number; fresh: boolean };
  ispId: string;
  ispName: string;
  asn?: number;
  resolverIp?: string;
  zone: string;
  domain: string;
  recordType: string;
  responseCode?: string;
  ecsRequested: boolean;
  ecsPrefix?: string;
  ecsHonoured?: boolean;
  ttl?: number;
  latencyMs?: number;
  confidence: DnsConfidence;
  comparisonStatus: DnsComparisonStatus;
  matchStatus?: DnsComparisonStatus;
  differences: DnsObservationDifference[];
  observedAnswers: { type: string; address: string }[];
  predictedAnswers: { answerId: string; addresses: string[]; deliveryPlatform?: string }[];
  predictedDistribution: { answerId: string; label: string; deliveryPlatform?: string; share: number }[];
  observedOrder: string[];
  recordChecksum?: string;
  explanation?: string;
  warnings: string[];
  provenance: { source: 'radar'; label: string; readOnly: true };
}

export interface DnsObservationStateItem {
  ispId: string;
  ispName: string;
  asn: number;
  observation: DnsObservationItem | null;
}

export interface DnsObservationStateResponse {
  provenance: { source: 'radar'; readOnly: true; retrievedAt: string };
  tierLabels: DnsTierLabels;
  count: number;
  items: DnsObservationStateItem[];
}

export interface DnsObservationRunResponse {
  provenance: { source: 'radar'; readOnly: true; retrievedAt: string };
  tierLabels: DnsTierLabels;
  count: number;
  results: DnsObservationItem[];
}

export interface DnsObservationHistoryResponse {
  provenance: { source: 'radar'; readOnly: true; retrievedAt: string };
  count: number;
  items: DnsObservationItem[];
}

// --- NS1 live validation -----------------------------------------------------

export type ValidationOverallStatus = 'compatible' | 'compatible_with_warnings' | 'partial' | 'incompatible' | 'unavailable';

export interface ValidationFieldTypeMismatch {
  path: string;
  expected: string;
  actual: string;
}
export interface ValidationUnsupportedFeature {
  kind: 'filter' | 'metadata' | 'structure';
  name: string;
  detail: string;
}
export interface ValidationFixtureComparison {
  provisionalFixtureFields: string[];
  liveOnlyFields: string[];
  typeMismatches: ValidationFieldTypeMismatch[];
  matches: boolean;
}
export interface ValidationSanitisedCandidate {
  provenance: {
    source: 'ns1';
    mode: string;
    endpoint: string;
    resourceKey: string;
    retrievedAt: string;
    rawChecksum: string;
    generatedBy: string;
    warning: string;
    reviewRequired: string[];
  };
  payload: unknown;
}

export interface ValidationResultItem {
  id?: string;
  endpoint: string;
  resourceKey?: string;
  zone?: string;
  domain?: string;
  recordType?: string;
  sourceMode: string;
  retrievedAt: string;
  ranAt?: string;
  rawChecksum?: string;
  structuralChecksum?: string;
  overallStatus: ValidationOverallStatus;
  schemaCompatible: boolean;
  schemaIssues?: string[];
  adapterCompatible: boolean;
  supportedFilters: string[];
  unsupportedFilters: string[];
  unknownMetadataFields: string[];
  unexpectedFields: string[];
  missingExpectedFields: string[];
  fieldTypeMismatches: ValidationFieldTypeMismatch[];
  unsupportedFeatures: ValidationUnsupportedFeature[];
  answerGroupsPresent: boolean;
  feedControlledMetadataPresent: boolean;
  ecs: { present: boolean; enabled?: boolean };
  fixtureComparison: ValidationFixtureComparison;
  warnings: string[];
  sanitisedSample?: unknown;
  fixtureCandidate?: ValidationSanitisedCandidate;
}

export interface ValidationRunResponse {
  provenance: { source: 'radar'; readOnly: true; notice: string; retrievedAt: string };
  mode: string;
  rawWithheld?: boolean;
  count: number;
  results: ValidationResultItem[];
}
export interface ValidationResultsResponse {
  provenance: { source: 'radar'; readOnly: true; notice: string; retrievedAt: string };
  mode?: string;
  count: number;
  items: ValidationResultItem[];
}
export interface ValidationResultResponse {
  provenance: { source: 'radar'; readOnly: true; notice: string; retrievedAt: string };
  item: ValidationResultItem;
}
export interface ValidationUnsupportedFeaturesResponse {
  provenance: { source: 'radar'; readOnly: true; notice: string; retrievedAt: string };
  unsupportedFilters: { name: string; count: number }[];
  unknownMetadataFields: { name: string; count: number }[];
}

// --- CloudVision network telemetry (read-only, informational) ---

export type CloudVisionSource = 'mock' | 'cloudvision' | 'disabled';
export type FreshnessLevel = 'FRESH' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE';
export type LinkType = 'PRIVATE_PEERING' | 'IX_PEERING' | 'TRANSIT' | 'INTERNAL' | 'UNKNOWN';
export type OperState = 'up' | 'down' | 'unknown';
export type BgpState = 'ESTABLISHED' | 'IDLE' | 'CONNECT' | 'ACTIVE' | 'OPENSENT' | 'OPENCONFIRM' | 'UNKNOWN';
export type BandwidthSource = 'REPORTED' | 'DERIVED' | 'UNAVAILABLE';
export type NetworkHealth = 'healthy' | 'warning' | 'critical' | 'down' | 'unavailable' | 'unknown';

export interface CvFreshness {
  level: FreshnessLevel;
  ageSeconds: number | null;
  staleAfterSeconds: number;
}

export interface NetworkProvenance {
  source: 'radar';
  telemetryMode: CloudVisionSource;
  readOnly: true;
  informationalOnly: true;
  notice: string;
  retrievedAt: string;
}

export interface NetworkDevice {
  id: string;
  hostname: string;
  modelName: string | null;
  softwareVersion: string | null;
  streaming: boolean;
  reachable: boolean;
  freshness: CvFreshness;
  observedAt: string | null;
  source: CloudVisionSource;
  warnings?: string[];
}

export interface NetworkInterface {
  deviceId: string;
  deviceHostname: string;
  name: string;
  description: string | null;
  provider: string | null;
  location: string | null;
  linkType: LinkType;
  /** Port-Channel this interface is a member of; null if standalone or a Port-Channel itself. */
  memberOf: string | null;
  adminState: OperState;
  operState: OperState;
  speedBps: number | null;
  inBps: number | null;
  outBps: number | null;
  primaryBps: number | null;
  bandwidthSource: BandwidthSource;
  utilisationPercent: number | null;
  headroomBps: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  status: NetworkHealth;
  freshness: CvFreshness;
  observedAt: string | null;
  source: CloudVisionSource;
  // Engineering detail (present only with ns1.detail.read).
  classificationSource?: string;
  warnings?: string[];
}

export interface BgpPeer {
  deviceId: string;
  deviceHostname: string;
  peerAddress: string;
  peerAsn: number | null;
  provider: string | null;
  connectionType: string | null;
  description: string | null;
  state: BgpState;
  established: boolean;
  uptimeSeconds: number | null;
  prefixesReceived: number | null;
  prefixesAdvertised: number | null;
  interfaceId: string | null;
  localAddress: string | null;
  routerId: string | null;
  adminShutdown: boolean | null;
  addressFamilies: string[];
  status: NetworkHealth;
  freshness: CvFreshness;
  observedAt: string | null;
  source: CloudVisionSource;
  warnings?: string[];
}

export interface LinkGroup {
  key: string;
  label: string;
  linkType: LinkType;
  capacityBps: number | null;
  currentBps: number | null;
  utilisationPercent: number | null;
  headroomBps: number | null;
  healthyLinks: number;
  totalLinks: number;
  status: NetworkHealth;
  freshness: CvFreshness;
  interfaceIds: string[];
}

export interface NetworkSummary {
  totalEdgeThroughputBps: number | null;
  totalPeeringThroughputBps: number | null;
  totalTransitThroughputBps: number | null;
  operationalCapacityBps: number | null;
  operationalHeadroomBps: number | null;
  unhealthyLinks: number;
  unhealthyBgpPeers: number;
  deviceCount: number;
  interfaceCount: number;
  unknownInterfaceCount: number;
  telemetryAgeSeconds: number | null;
}

export interface NetworkCompleteness {
  expectedDevices: number;
  observedDevices: number;
  interfacesWithBandwidth: number;
  totalInterfaces: number;
  level: 'complete' | 'partial' | 'empty';
}

export interface ConnectorStatus {
  enabled: boolean;
  running: boolean;
  source: CloudVisionSource;
  intervalMs: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  snapshotAgeSeconds: number | null;
  historyLength: number;
  deviceCount: number;
  interfaceCount: number;
  unknownInterfaceCount: number;
  /** Edge-device IDs the connector is filtered to; 0 = no filter (all devices shown). */
  edgeDeviceIdCount: number;
}

export interface HistoryPoint {
  at: string;
  totalEdgeThroughputBps: number | null;
  totalPeeringThroughputBps: number | null;
  totalTransitThroughputBps: number | null;
  operationalCapacityBps: number | null;
  operationalHeadroomBps: number | null;
  unhealthyLinks: number;
  unhealthyBgpPeers: number;
  freshness: FreshnessLevel;
}

export interface NetworkStatusResponse {
  provenance: NetworkProvenance;
  status: ConnectorStatus;
  summary: NetworkSummary | null;
  freshness: CvFreshness | null;
  completeness: NetworkCompleteness | null;
  warnings: string[];
  capturedAt: string | null;
}
export interface NetworkDevicesResponse { provenance: NetworkProvenance; count: number; items: NetworkDevice[] }
export interface NetworkInterfacesResponse { provenance: NetworkProvenance; count: number; items: NetworkInterface[] }
export interface NetworkLinkGroupsResponse { provenance: NetworkProvenance; count: number; items: LinkGroup[] }
export interface NetworkBgpPeersResponse { provenance: NetworkProvenance; count: number; items: BgpPeer[] }
export interface NetworkHistoryResponse { provenance: NetworkProvenance; count: number; items: HistoryPoint[] }

// --- CloudVision connection settings (Engineer-managed; token write-only) ---

export interface ConnectorSettingsView {
  connector: 'cloudvision';
  enabled: boolean;
  mode: 'mock' | 'live';
  endpoint: string | null;
  verifyTls: boolean;
  edgeDeviceIds: string[];
  /** Whether a token is configured — the token itself is never returned. */
  tokenConfigured: boolean;
  tokenSetAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  source: 'database' | 'environment';
  masterKeyAvailable: boolean;
  degraded: string | null;
}
export interface ConnectorSettingsResponse { settings: ConnectorSettingsView }

export interface ConnectorSettingsUpdateRequest {
  enabled?: boolean;
  mode?: 'mock' | 'live';
  endpoint?: string | null;
  verifyTls?: boolean;
  edgeDeviceIds?: string[] | null;
  /** Write-only. Omit or leave blank to keep the stored token; non-empty replaces it. */
  token?: string;
  clearToken?: boolean;
}

export interface ConnectorTestResult {
  ok: boolean;
  source: string;
  error?: string;
  summary?: { devices: number; interfaces: number; bgpPeers: number; freshness: string };
}
export interface ConnectorTestResponse { result: ConnectorTestResult }

// --- Cloudflare Load Balancing (read-only; origin-pool selection downstream of NS1) ---------
export type CloudflareSource = 'cloudflare' | 'mock' | 'disabled';
export interface CloudflareProvenance {
  source: CloudflareSource; synthetic: boolean; readOnly: boolean; informationalOnly: boolean; notice: string; retrievedAt: string;
}
export interface CloudflareOriginRegionHealth { region: string; healthy: boolean | null; rttMs: number | null; failureReason: string | null }
export interface CloudflareOrigin {
  name: string; address: string; weight: number; enabled: boolean; healthy: boolean | null; failureReason: string | null;
  hostHeader: string | null; rttMs: number | null; regionHealth: CloudflareOriginRegionHealth[];
}
export interface CloudflareHealthCheck {
  type: string; method: string | null; path: string | null; expectedCodes: string | null; expectedBody: string | null;
  intervalSeconds: number | null; timeoutSeconds: number | null; retries: number | null;
  port: number | null; consecutiveUp: number | null; consecutiveDown: number | null; followRedirects: boolean | null; allowInsecure: boolean | null;
}
export interface CloudflareLoadShedding { defaultPercent: number | null; defaultPolicy: string | null; sessionPercent: number | null; sessionPolicy: string | null }
export interface CloudflarePool {
  id: string; name: string; description: string | null; enabled: boolean; healthy: boolean | null; monitorId: string | null;
  healthCheck: CloudflareHealthCheck | null; minimumOrigins: number | null; origins: CloudflareOrigin[]; healthyOrigins: number; totalOrigins: number;
  originSteeringPolicy: string | null; loadShedding: CloudflareLoadShedding | null; checkRegions: string[]; notificationEmail: string | null;
}
export interface CloudflareSteeredPool { poolId: string; poolName: string | null; weight: number | null }
export interface CloudflareObservedBucket { key: string; requests: number; sharePercent: number }
export interface CloudflareObserved { windowHours: number; totalRequests: number; byPool: CloudflareObservedBucket[]; byRegion: CloudflareObservedBucket[]; byColo: CloudflareObservedBucket[]; byOrigin: CloudflareObservedBucket[] }
export interface CloudflareSessionAffinityAttributes { samesite: string | null; secure: string | null; drainDuration: number | null; zeroDowntimeFailover: string | null }
export interface CloudflareLoadBalancer {
  id: string; name: string; zoneName: string | null; enabled: boolean; proxied: boolean; steeringPolicy: string;
  defaultPools: CloudflareSteeredPool[]; fallbackPool: CloudflareSteeredPool | null;
  regionPools: Record<string, CloudflareSteeredPool[]>; popPools: Record<string, CloudflareSteeredPool[]>; countryPools: Record<string, CloudflareSteeredPool[]>;
  sessionAffinity: string | null; sessionAffinityTtl: number | null; sessionAffinityAttributes: CloudflareSessionAffinityAttributes | null;
  locationStrategy: string | null; adaptiveRoutingFailoverAcrossPools: boolean | null; randomSteeringDefaultWeight: number | null; ttlSeconds: number | null;
  observed: CloudflareObserved | null;
}
export interface CloudflareSummary {
  loadBalancerCount: number; poolCount: number; originCount: number; unhealthyPools: number; unhealthyOrigins: number;
}
export interface CloudflareConnectorStatus {
  enabled: boolean; running: boolean; source: CloudflareSource | null; intervalMs: number;
  lastPollAt: string | null; lastSuccessAt: string | null; lastDurationMs: number | null; consecutiveFailures: number;
  lastError: string | null; snapshotAgeSeconds: number | null; loadBalancerCount: number; poolCount: number;
}
export interface CloudflareStatusResponse { status: CloudflareConnectorStatus | null; summary: CloudflareSummary | null; provenance: CloudflareProvenance; warnings: string[] }
export interface CloudflareListResponse<T> { provenance: CloudflareProvenance; count: number; items: T[] }
export interface CloudflareFocusedPoolHealth { id: string; origins: { address: string; rttMs: number | null; regionHealth: CloudflareOriginRegionHealth[] }[] }
export interface CloudflareRefreshResponse { provenance: CloudflareProvenance; pools: CloudflareFocusedPoolHealth[]; capped: boolean; max: number }

// Engineer-managed Cloudflare connection settings (account id + zones + write-only token).
export interface CloudflareConnectionSettings {
  connector: 'cloudflare'; enabled: boolean; mode: 'mock' | 'live'; accountId: string | null; zones: string[];
  tokenConfigured: boolean; tokenSetAt: string | null; updatedBy: string | null; updatedAt: string | null;
  source: 'database' | 'environment'; masterKeyAvailable: boolean; degraded: string | null;
}
export interface CloudflareConnectionResponse { settings: CloudflareConnectionSettings }
export interface CloudflareConnectionUpdateRequest { enabled?: boolean; mode?: 'mock' | 'live'; accountId?: string | null; zones?: string[] | null; token?: string; clearToken?: boolean }
export interface CloudflareConnectionTestResult { ok: boolean; source: string; error?: string; summary?: { loadBalancers: number; pools: number; origins: number } }
export interface CloudflareConnectionTestResponse { result: CloudflareConnectionTestResult }

// --- Fastly CDN observability (read-only; a commercial CDN delivery platform) ----------------
export type FastlySource = 'fastly' | 'mock' | 'disabled';
export interface FastlyProvenance {
  source: FastlySource; synthetic: boolean; readOnly: boolean; informationalOnly: boolean; notice: string; retrievedAt: string;
}
export interface FastlyServiceStats {
  serviceId: string; serviceName: string; windowSeconds: number;
  requests: number; requestsPerSecond: number; hits: number; miss: number; hitRatioPercent: number | null;
  bandwidthBytes: number; bandwidthBps: number; originFetches: number; originOffloadPercent: number | null;
  status2xx: number; status3xx: number; status4xx: number; status5xx: number; errorRatePercent: number | null;
}
export interface FastlySummary {
  serviceCount: number; totalRequestsPerSecond: number; totalBandwidthBps: number; avgHitRatioPercent: number | null;
}
export interface FastlyConnectorStatus {
  enabled: boolean; running: boolean; source: FastlySource | null; intervalMs: number;
  lastPollAt: string | null; lastSuccessAt: string | null; lastDurationMs: number | null; consecutiveFailures: number;
  lastError: string | null; snapshotAgeSeconds: number | null; serviceCount: number;
}
// Real-time (per-second) live-tail sourced from Fastly real-time analytics. Live-only.
export interface FastlyRealtimeSample {
  second: number; at: string; requests: number; hits: number; miss: number; errors: number;
  bandwidthBytes: number; status2xx: number; status3xx: number; status4xx: number; status5xx: number;
  /** Per specific status code with traffic this second, e.g. { "200": 680, "404": 12 }. */
  statusCodes: Record<string, number>;
}
export interface FastlyRealtimeSeries {
  serviceId: string; serviceName: string; samples: FastlyRealtimeSample[];
  latestRequestsPerSecond: number | null; latestBandwidthBps: number | null; lastSampleAt: string | null;
}
export interface FastlyRealtimeServiceStatus {
  serviceId: string; serviceName: string; running: boolean; sampleCount: number;
  lastSampleAt: string | null; lastPollAt: string | null; consecutiveFailures: number; lastError: string | null;
}
export interface FastlyRealtimeStatus {
  enabled: boolean; running: boolean; source: FastlySource; windowSeconds: number; services: FastlyRealtimeServiceStatus[];
}
export interface FastlyStatusResponse { status: FastlyConnectorStatus | null; realtime: FastlyRealtimeStatus | null; summary: FastlySummary | null; provenance: FastlyProvenance; warnings: string[] }
export interface FastlyServicesResponse { provenance: FastlyProvenance; count: number; items: FastlyServiceStats[] }
export interface FastlyRealtimeResponse { provenance: FastlyProvenance; source: FastlySource; windowSeconds: number; series: FastlyRealtimeSeries[]; warnings: string[] }

// --- Akamai CDN observability (read-only; DataStream 2 edge logs aggregated by RADAR) -----------
export type AkamaiSource = 'akamai' | 'disabled';
export interface AkamaiProvenance {
  source: AkamaiSource; synthetic: boolean; readOnly: boolean; informationalOnly: boolean; notice: string; retrievedAt: string;
}
export interface AkamaiSample {
  second: number; at: string; requests: number; hits: number; miss: number; bandwidthBytes: number;
  status2xx: number; status3xx: number; status4xx: number; status5xx: number; statusCodes: Record<string, number>;
}
export interface AkamaiSeries {
  serviceId: string; serviceName: string; samples: AkamaiSample[];
  latestRequestsPerSecond: number | null; latestBandwidthBps: number | null; lastSampleAt: string | null;
}
export interface AkamaiRealtimeResponse { provenance: AkamaiProvenance; source: AkamaiSource; windowSeconds: number; series: AkamaiSeries[]; warnings: string[] }

// Engineer-managed Akamai (DataStream 2 → S3) connection settings. The S3 secret key is write-only.
export interface AkamaiConnectionSettings {
  connector: 'akamai'; enabled: boolean; cpCodes: string[]; cpNames: Record<string, string>;
  s3: { bucket: string; region: string; prefix: string; accessKeyId: string; pollIntervalSeconds: number };
  windowSeconds: number; secretConfigured: boolean; secretSetAt: string | null; updatedBy: string | null; updatedAt: string | null;
  source: 'database' | 'environment'; masterKeyAvailable: boolean; connected: boolean; degraded: string | null;
}
export interface AkamaiConnectionResponse { settings: AkamaiConnectionSettings }
export interface AkamaiConnectionUpdate {
  enabled?: boolean; cpCodes?: string[] | null; cpNames?: Record<string, string> | null;
  bucket?: string | null; region?: string | null; prefix?: string | null; accessKeyId?: string | null;
  pollIntervalSeconds?: number | null; windowSeconds?: number | null; secretKey?: string; clearSecret?: boolean;
}
export interface AkamaiConnectionTestResult { ok: boolean; source: string; error?: string; summary?: { objects: number } }
export interface AkamaiConnectionTestResponse { result: AkamaiConnectionTestResult }

// Engineer-managed Fastly connection settings (API base + service ids + write-only token).
export interface FastlyConnection {
  connector: 'fastly'; enabled: boolean; mode: 'mock' | 'live'; apiBase: string; serviceIds: string[];
  tokenConfigured: boolean; tokenSetAt: string | null; updatedBy: string | null; updatedAt: string | null;
  source: 'database' | 'environment'; masterKeyAvailable: boolean; degraded: string | null;
}
export interface FastlyConnectionResponse { settings: FastlyConnection }
export interface FastlyConnectionUpdate { enabled?: boolean; mode?: 'mock' | 'live'; apiBase?: string | null; serviceIds?: string[] | null; token?: string; clearToken?: boolean }
export interface FastlyConnectionTestResult { ok: boolean; source: string; error?: string; summary?: { services: number } }
export interface FastlyConnectionTestResponse { result: FastlyConnectionTestResult }

// Engineer-managed NS1 connection settings (mode + API base + read-only key). The key is write-only.
export interface Ns1ConnectionSettings {
  connector: 'ns1'; mode: 'mock' | 'live'; apiBase: string; keyConfigured: boolean; keySetAt: string | null;
  updatedBy: string | null; updatedAt: string | null; source: 'database' | 'environment'; live: boolean; masterKeyAvailable: boolean; degraded: string | null;
}
export interface Ns1ConnectionResponse { settings: Ns1ConnectionSettings }
export interface Ns1ConnectionUpdate { mode?: 'mock' | 'live'; apiBase?: string | null; key?: string; clearKey?: boolean }
export interface Ns1ConnectionTestResult { ok: boolean; source: string; error?: string; summary?: { zones: number } }
export interface Ns1ConnectionTestResponse { result: Ns1ConnectionTestResult }

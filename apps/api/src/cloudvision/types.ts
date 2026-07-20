// Canonical, VENDOR-NEUTRAL network-state model for RADAR. The rest of RADAR (routes, UI,
// and later the Traffic Policy Controller) depends ONLY on these types — never on Arista
// CloudVision wire shapes, which are confined to the live client + adapter. Telemetry is
// READ-ONLY and INFORMATIONAL: reading it never writes to any device, to CloudVision, or to
// NS1. Observed values are kept strictly distinct from configured facts, and an absent or
// stale value is NEVER turned into an invented number.

/** How an interface/link is used. Derived by configuration-driven classification; an
 *  interface that cannot be classified stays visible as UNKNOWN (never dropped). */
export type LinkType = 'PRIVATE_PEERING' | 'IX_PEERING' | 'TRANSIT' | 'INTERNAL' | 'UNKNOWN';

/** Which classification rule matched (for explainability / audit of unknowns). */
export type ClassificationSource = 'device_interface' | 'description_exact' | 'description_regex' | 'unknown';

/** Operational / administrative link state. `unknown` when the source did not report it. */
export type OperState = 'up' | 'down' | 'unknown';

/** BGP session state — the canonical FSM states, plus UNKNOWN for anything unrecognised. */
export type BgpState =
  | 'ESTABLISHED'
  | 'IDLE'
  | 'CONNECT'
  | 'ACTIVE'
  | 'OPENSENT'
  | 'OPENCONFIRM'
  | 'UNKNOWN';

/** Where a bandwidth figure came from. REPORTED = streamed directly by CloudVision; DERIVED
 *  = computed from interface counters across two samples; UNAVAILABLE = neither was usable
 *  (rendered as "no value", never fabricated). */
export type BandwidthSource = 'REPORTED' | 'DERIVED' | 'UNAVAILABLE';

/** Time-based freshness of an observation. FRESH ≤ staleAfter; DEGRADED within 2× the
 *  window (ageing); STALE beyond that; UNAVAILABLE when there is no observation at all. */
export type FreshnessLevel = 'FRESH' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE';

/** Derived health of an interface / link-group / BGP peer. Combines operational state with
 *  utilisation classification. `unknown` = insufficient data to classify. */
export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'down' | 'unavailable' | 'unknown';

/** The telemetry source behind a snapshot. `cloudvision` = live read-only CloudVision. */
export type CloudVisionSource = 'mock' | 'cloudvision' | 'disabled';

export interface Freshness {
  level: FreshnessLevel;
  /** Age of the observation in seconds (null when there is no observation). */
  ageSeconds: number | null;
  /** Window (seconds) after which an observation is no longer FRESH. */
  staleAfterSeconds: number;
}

/** Provenance stamped on every canonical object. Never contains a URL, token or device
 *  credential. `readOnly` is structural: this connector has no write capability. */
export interface CloudVisionProvenance {
  source: CloudVisionSource;
  /** True for mock/synthetic data — never real production telemetry. */
  synthetic: boolean;
  readOnly: true;
  note: string;
}

export interface NetworkDevice {
  /** CloudVision device id (serial). Stable across polls. */
  id: string;
  hostname: string;
  modelName: string | null;
  softwareVersion: string | null;
  /** Whether the device is actively streaming telemetry to CloudVision. */
  streaming: boolean;
  /** Whether RADAR could retrieve current state for this device this poll. */
  reachable: boolean;
  freshness: Freshness;
  observedAt: string | null;
  warnings: string[];
  provenance: CloudVisionProvenance;
}

export interface NetworkInterface {
  deviceId: string;
  deviceHostname: string;
  /** Interface name as reported by the device (e.g. `Ethernet1`). */
  name: string;
  description: string | null;
  // Classification (RADAR configuration-driven) — the provider/location are derived facts,
  // not observed telemetry.
  provider: string | null;
  location: string | null;
  linkType: LinkType;
  classificationSource: ClassificationSource;
  /** The Port-Channel this interface is a member of (from device LAG config); null if it is
   *  a standalone port or itself a Port-Channel. */
  memberOf: string | null;
  // Observed operational state.
  adminState: OperState;
  operState: OperState;
  /** Interface speed / configured capacity in bits per second (null if unknown). */
  speedBps: number | null;
  // Observed throughput.
  inBps: number | null;
  outBps: number | null;
  /** The direction that drives utilisation (outbound by default). */
  primaryBps: number | null;
  bandwidthSource: BandwidthSource;
  /** primaryBps / speedBps × 100 (null when either is unavailable). */
  utilisationPercent: number | null;
  /** speedBps − primaryBps (null when either is unavailable). */
  headroomBps: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  status: HealthStatus;
  freshness: Freshness;
  observedAt: string | null;
  warnings: string[];
  provenance: CloudVisionProvenance;
}

/** Whether a BGP session is a real delivery path or non-delivery infrastructure. */
export type BgpSessionRole = 'delivery' | 'route-collector' | 'internal';

export interface BgpPeer {
  deviceId: string;
  deviceHostname: string;
  peerAddress: string;
  peerAsn: number | null;
  /** Provider derived from classification (by ASN or peer address), when known. */
  provider: string | null;
  /** Human connection type from the peer description tag (PNI / INEX / Transit / Peer / …). */
  connectionType: string | null;
  /** Session role derived from the connection type. Only `delivery` sessions carry
   *  customer/audience traffic; `route-collector` and `internal` (iBGP) sessions are excluded
   *  from the edge provider/delivery view. */
  role: BgpSessionRole;
  /** Raw peer description (e.g. "[PNI] Eir"). */
  description: string | null;
  state: BgpState;
  established: boolean;
  uptimeSeconds: number | null;
  prefixesReceived: number | null;
  prefixesAdvertised: number | null;
  /** Physical interface the session runs over (correlates to the interface table). */
  interfaceId: string | null;
  localAddress: string | null;
  /** Remote peer's BGP router-id. */
  routerId: string | null;
  adminShutdown: boolean | null;
  /** Active address families (short labels, e.g. ["IPv4","IPv6"]). */
  addressFamilies: string[];
  status: HealthStatus;
  freshness: Freshness;
  observedAt: string | null;
  warnings: string[];
  provenance: CloudVisionProvenance;
}

/** An aggregate over a set of interfaces (by provider or link type). Utilisation is ALWAYS
 *  total-throughput / total-capacity — never an average of per-interface percentages. */
export interface LinkGroupState {
  key: string;
  label: string;
  linkType: LinkType;
  interfaceIds: string[];
  /** Sum of member speeds (configured capacity); null if no member speed is known. */
  capacityBps: number | null;
  /** Sum of member primary throughput; null if no member has usable throughput. */
  currentBps: number | null;
  utilisationPercent: number | null;
  headroomBps: number | null;
  healthyLinks: number;
  totalLinks: number;
  status: HealthStatus;
  freshness: Freshness;
  provenance: CloudVisionProvenance;
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
  /** Age (seconds) of the freshest device observation in the snapshot; null if none. */
  telemetryAgeSeconds: number | null;
}

/** How complete the snapshot is (missing devices, or interfaces with no usable bandwidth).
 *  Completeness is reported, never silently hidden. */
export interface Completeness {
  expectedDevices: number;
  observedDevices: number;
  interfacesWithBandwidth: number;
  totalInterfaces: number;
  level: 'complete' | 'partial' | 'empty';
}

/** The complete canonical network state at one instant. Everything RADAR reasons about the
 *  edge derives from this object. */
export interface NetworkStateSnapshot {
  capturedAt: string;
  source: CloudVisionSource;
  devices: NetworkDevice[];
  interfaces: NetworkInterface[];
  bgpPeers: BgpPeer[];
  linkGroups: LinkGroupState[];
  summary: NetworkSummary;
  /** Worst freshness across observed devices (overall snapshot freshness). */
  freshness: Freshness;
  completeness: Completeness;
  warnings: string[];
  provenance: CloudVisionProvenance;
}

/** Read-only network-state client. Implementations return a fully-classified snapshot; a
 *  total upstream failure yields an empty/`unavailable` snapshot (never an exception, never
 *  invented values). There is deliberately NO write/mutate method. */
export interface CloudVisionClient {
  getSnapshot(correlationId?: string): Promise<NetworkStateSnapshot>;
}

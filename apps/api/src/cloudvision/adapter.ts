// The CloudVision ADAPTER: turns vendor-neutral RAW observations (produced by the mock or
// live client) into RADAR's canonical NetworkStateSnapshot. All business logic lives here —
// classification, unit handling, bandwidth resolution, freshness, aggregation and warning
// generation — never in the API client. Aggregate utilisation is ALWAYS total-throughput /
// total-capacity (never an average of per-interface percentages). Nothing is ever invented:
// an absent or stale value stays absent/flagged.
import { classifyInterface, type ClassificationRule } from './classification.js';
import { deriveBandwidthBps, headroomBps, resolveBandwidth, utilisationPercent, type CounterSample } from './throughput.js';
import type {
  BgpPeer, BgpState, CloudVisionProvenance, CloudVisionSource, Completeness, Freshness, FreshnessLevel,
  HealthStatus, LinkGroupState, LinkType, NetworkDevice, NetworkInterface, NetworkStateSnapshot,
  NetworkSummary, OperState,
} from './types.js';

// ---- Raw input contract (vendor-neutral, pre-classification) --------------------------------

export interface RawDevice {
  id: string;
  hostname: string;
  modelName: string | null;
  softwareVersion: string | null;
  streaming: boolean;
  reachable: boolean;
  observedAt: Date | null;
  warnings?: string[];
}

export interface RawInterface {
  deviceId: string;
  name: string;
  description: string | null;
  adminState: OperState;
  operState: OperState;
  speedBps: number | null;
  /** Directly-reported bit-rates (preferred over derivation) — null if not streamed. */
  reportedInBps: number | null;
  reportedOutBps: number | null;
  /** Current cumulative octet counters (for derivation when a rate is not reported). */
  inOctets: bigint | null;
  outOctets: bigint | null;
  counterMaxOctets?: bigint;
  /** The device rebooted since the previous sample → counters reset (no rollover maths). */
  rebooted?: boolean;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  observedAt: Date | null;
  /** Port-Channel this interface is a member of (from device LAG config), if any. */
  memberOf?: string | null;
  warnings?: string[];
}

/** The previous counter reading for one interface, held by the client between polls. */
export interface PreviousCounters {
  inOctets: bigint | null;
  outOctets: bigint | null;
  at: Date | null;
}

export interface RawBgpPeer {
  deviceId: string;
  peerAddress: string;
  peerAsn: number | null;
  /** Raw device state string; normalised to a canonical BgpState here. */
  state: string;
  uptimeSeconds: number | null;
  prefixesReceived: number | null;
  prefixesAdvertised: number | null;
  observedAt: Date | null;
  /** Provider derived from a verified source (e.g. the peer description tag); preferred over
   *  the ASN map. Never a fabricated association. */
  providerHint?: string | null;
  /** Physical interface the session runs over (from the peer record's intfId). */
  interfaceId?: string | null;
  localAddress?: string | null;
  /** Remote peer's BGP router-id. */
  routerId?: string | null;
  adminShutdown?: boolean | null;
  addressFamilies?: string[];
  warnings?: string[];
}

export interface RawSnapshot {
  devices: RawDevice[];
  interfaces: RawInterface[];
  bgpPeers: RawBgpPeer[];
  /** Previous counters per `${deviceId}::${name}` for bandwidth derivation (optional). */
  previousCounters?: Map<string, PreviousCounters>;
}

export interface AdapterConfig {
  source: CloudVisionSource;
  synthetic: boolean;
  /** Epoch ms; injected for determinism. */
  now: number;
  staleAfterSeconds: number;
  /** Configured edge device ids (for completeness / missing-device warnings). */
  expectedDeviceIds: string[];
  classificationRules: ClassificationRule[];
  /** Optional ASN → provider map for BGP peers. */
  providerForAsn?: Record<number, string>;
  warningPercent: number;
  criticalPercent: number;
  /** Direction that drives utilisation (default outbound). */
  primaryDirection?: 'inbound' | 'outbound';
}

// ---- Helpers --------------------------------------------------------------------------------

export const counterKey = (deviceId: string, name: string): string => `${deviceId}::${name}`;

const HEALTH_SEVERITY: Record<HealthStatus, number> = {
  unknown: -1, unavailable: -1, healthy: 0, warning: 1, critical: 2, down: 3,
};
const worstHealth = (...s: HealthStatus[]): HealthStatus =>
  s.reduce((w, x) => (HEALTH_SEVERITY[x] > HEALTH_SEVERITY[w] ? x : w), 'unknown');

/** Freshness from an observation age. FRESH ≤ window; DEGRADED ≤ 2× window; else STALE;
 *  UNAVAILABLE when there is no observation. */
export function freshnessOf(observedAt: Date | null, now: number, staleAfterSeconds: number): Freshness {
  if (observedAt === null) return { level: 'UNAVAILABLE', ageSeconds: null, staleAfterSeconds };
  const ageSeconds = Math.max(0, (now - observedAt.getTime()) / 1000);
  const level: FreshnessLevel = ageSeconds <= staleAfterSeconds ? 'FRESH' : ageSeconds <= staleAfterSeconds * 2 ? 'DEGRADED' : 'STALE';
  return { level, ageSeconds, staleAfterSeconds };
}

/** Freshness of an aggregate: worst (oldest) age among members that have one; UNAVAILABLE if
 *  none do. A single member with no data does not blank an otherwise-fresh group. */
function aggregateFreshness(members: Freshness[], now: number, staleAfterSeconds: number): Freshness {
  const ages = members.map((f) => f.ageSeconds).filter((a): a is number => a !== null);
  if (ages.length === 0) return { level: 'UNAVAILABLE', ageSeconds: null, staleAfterSeconds };
  const maxAge = Math.max(...ages);
  return freshnessOf(new Date(now - maxAge * 1000), now, staleAfterSeconds);
}

/** Normalise a device BGP state string to the canonical FSM state. */
export function normaliseBgpState(raw: string): BgpState {
  const s = raw.replace(/[\s_-]/g, '').toUpperCase();
  switch (s) {
    case 'ESTABLISHED': return 'ESTABLISHED';
    case 'IDLE': return 'IDLE';
    case 'CONNECT': return 'CONNECT';
    case 'ACTIVE': return 'ACTIVE';
    case 'OPENSENT': return 'OPENSENT';
    case 'OPENCONFIRM': return 'OPENCONFIRM';
    default: return 'UNKNOWN';
  }
}

function provenanceFor(source: CloudVisionSource, synthetic: boolean): CloudVisionProvenance {
  return {
    source,
    synthetic,
    readOnly: true,
    note:
      source === 'disabled'
        ? 'CloudVision telemetry is disabled; network state is not connected.'
        : synthetic
          ? 'MOCK / SYNTHETIC — not production telemetry.'
          : 'Observed CloudVision telemetry (read-only; RADAR issues no device or CloudVision writes).',
  };
}

/** Sum a list of nullable numbers; null only if EVERY value is null (so a partial group still
 *  reports the throughput it can see). */
function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

const EXTERNAL: LinkType[] = ['PRIVATE_PEERING', 'IX_PEERING', 'TRANSIT'];
const PEERING: LinkType[] = ['PRIVATE_PEERING', 'IX_PEERING'];
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---- Per-object builders --------------------------------------------------------------------

function buildDevice(raw: RawDevice, cfg: AdapterConfig): NetworkDevice {
  const freshness = freshnessOf(raw.observedAt, cfg.now, cfg.staleAfterSeconds);
  const warnings = [...(raw.warnings ?? [])];
  if (!raw.streaming) warnings.push('Device is not streaming telemetry to CloudVision.');
  if (!raw.reachable) warnings.push('Device state could not be retrieved this poll.');
  return {
    id: raw.id,
    hostname: raw.hostname,
    modelName: raw.modelName,
    softwareVersion: raw.softwareVersion,
    streaming: raw.streaming,
    reachable: raw.reachable,
    freshness,
    observedAt: raw.observedAt ? raw.observedAt.toISOString() : null,
    warnings,
    provenance: provenanceFor(cfg.source, cfg.synthetic),
  };
}

function interfaceStatus(operState: OperState, utilisation: number | null, hasObservation: boolean, cfg: AdapterConfig): HealthStatus {
  if (!hasObservation) return 'unavailable';
  if (operState === 'down') return 'down';
  if (operState === 'unknown') return 'unknown';
  if (utilisation === null) return 'healthy'; // up, but load not measurable (freshness/bandwidthSource say why)
  if (utilisation >= cfg.criticalPercent) return 'critical';
  if (utilisation >= cfg.warningPercent) return 'warning';
  return 'healthy';
}

function buildInterface(raw: RawInterface, prev: PreviousCounters | undefined, deviceHostname: string, cfg: AdapterConfig): NetworkInterface {
  const cls = classifyInterface(cfg.classificationRules, { deviceId: raw.deviceId, name: raw.name, description: raw.description });
  const warnings = [...(raw.warnings ?? [])];

  const curIn: CounterSample | null = raw.inOctets !== null && raw.observedAt !== null ? { octets: raw.inOctets, at: raw.observedAt } : null;
  const curOut: CounterSample | null = raw.outOctets !== null && raw.observedAt !== null ? { octets: raw.outOctets, at: raw.observedAt } : null;
  const prevIn: CounterSample | null = prev?.inOctets != null && prev.at !== null ? { octets: prev.inOctets, at: prev.at } : null;
  const prevOut: CounterSample | null = prev?.outOctets != null && prev.at !== null ? { octets: prev.outOctets, at: prev.at } : null;
  const derOpts = { speedBps: raw.speedBps, counterMaxOctets: raw.counterMaxOctets, rebooted: raw.rebooted };

  const inBw = resolveBandwidth(raw.reportedInBps, deriveBandwidthBps(prevIn, curIn, derOpts));
  const outBw = resolveBandwidth(raw.reportedOutBps, deriveBandwidthBps(prevOut, curOut, derOpts));
  for (const w of [...inBw.warnings, ...outBw.warnings]) if (!warnings.includes(w)) warnings.push(w);

  const direction = cfg.primaryDirection ?? 'outbound';
  const primary = direction === 'inbound' ? inBw : outBw;
  const primaryBps = primary.bps;
  const utilisation = utilisationPercent(primaryBps, raw.speedBps);
  const freshness = freshnessOf(raw.observedAt, cfg.now, cfg.staleAfterSeconds);
  const status = interfaceStatus(raw.operState, utilisation, raw.observedAt !== null, cfg);

  if (raw.speedBps === null && (raw.operState === 'up')) warnings.push('Interface speed unknown; utilisation cannot be computed.');
  if (cls.linkType === 'UNKNOWN') warnings.push('Interface is unclassified (UNKNOWN link type).');

  return {
    deviceId: raw.deviceId,
    deviceHostname,
    name: raw.name,
    description: raw.description,
    provider: cls.provider,
    location: cls.location,
    linkType: cls.linkType,
    classificationSource: cls.classificationSource,
    memberOf: raw.memberOf ?? null,
    adminState: raw.adminState,
    operState: raw.operState,
    speedBps: raw.speedBps,
    inBps: inBw.bps,
    outBps: outBw.bps,
    primaryBps,
    bandwidthSource: primary.source,
    utilisationPercent: utilisation,
    headroomBps: headroomBps(raw.speedBps, primaryBps),
    inErrors: raw.inErrors,
    outErrors: raw.outErrors,
    inDiscards: raw.inDiscards,
    outDiscards: raw.outDiscards,
    status,
    freshness,
    observedAt: raw.observedAt ? raw.observedAt.toISOString() : null,
    warnings,
    provenance: provenanceFor(cfg.source, cfg.synthetic),
  };
}

function bgpStatus(state: BgpState, hasObservation: boolean): HealthStatus {
  if (!hasObservation) return 'unavailable';
  if (state === 'ESTABLISHED') return 'healthy';
  if (state === 'IDLE') return 'critical';
  if (state === 'UNKNOWN') return 'unknown';
  return 'warning'; // CONNECT/ACTIVE/OPENSENT/OPENCONFIRM — transitional
}

function buildBgpPeer(raw: RawBgpPeer, deviceHostname: string, cfg: AdapterConfig): BgpPeer {
  const state = normaliseBgpState(raw.state);
  const warnings = [...(raw.warnings ?? [])];
  // A verified description hint wins over the ASN map; neither is fabricated.
  const provider = raw.providerHint ?? (raw.peerAsn !== null ? cfg.providerForAsn?.[raw.peerAsn] ?? null : null);
  if (state === 'UNKNOWN') warnings.push(`Unrecognised BGP state "${raw.state}".`);
  return {
    deviceId: raw.deviceId,
    deviceHostname,
    peerAddress: raw.peerAddress,
    peerAsn: raw.peerAsn,
    provider,
    state,
    established: state === 'ESTABLISHED',
    uptimeSeconds: raw.uptimeSeconds,
    prefixesReceived: raw.prefixesReceived,
    prefixesAdvertised: raw.prefixesAdvertised,
    interfaceId: raw.interfaceId ?? null,
    localAddress: raw.localAddress ?? null,
    routerId: raw.routerId ?? null,
    adminShutdown: raw.adminShutdown ?? null,
    addressFamilies: raw.addressFamilies ?? [],
    status: bgpStatus(state, raw.observedAt !== null),
    freshness: freshnessOf(raw.observedAt, cfg.now, cfg.staleAfterSeconds),
    observedAt: raw.observedAt ? raw.observedAt.toISOString() : null,
    warnings,
    provenance: provenanceFor(cfg.source, cfg.synthetic),
  };
}

// ---- Aggregation ----------------------------------------------------------------------------

/** Build one link group from a set of interfaces. Capacity/headroom count only operationally
 *  UP members (a down link contributes no available capacity). Utilisation = total/total. */
function buildGroup(key: string, label: string, members: NetworkInterface[], cfg: AdapterConfig): LinkGroupState {
  const up = members.filter((m) => m.operState === 'up');
  const capacityBps = sumOrNull(up.map((m) => m.speedBps));
  const currentBps = sumOrNull(members.map((m) => m.primaryBps));
  const utilisation = currentBps !== null && capacityBps !== null && capacityBps > 0 ? (currentBps / capacityBps) * 100 : null;
  const headroom = currentBps !== null && capacityBps !== null ? Math.max(0, capacityBps - currentBps) : null;
  const dominantLinkType = (members.find((m) => m.linkType !== 'UNKNOWN')?.linkType ?? members[0]?.linkType ?? 'UNKNOWN') as LinkType;
  return {
    key,
    label,
    linkType: dominantLinkType,
    interfaceIds: members.map((m) => counterKey(m.deviceId, m.name)),
    capacityBps,
    currentBps,
    utilisationPercent: utilisation,
    headroomBps: headroom,
    healthyLinks: members.filter((m) => m.status === 'healthy').length,
    totalLinks: members.length,
    status: worstHealth(...members.map((m) => m.status)),
    freshness: aggregateFreshness(members.map((m) => m.freshness), cfg.now, cfg.staleAfterSeconds),
    provenance: provenanceFor(cfg.source, cfg.synthetic),
  };
}

/** Provider groups (the dashboard's provider cards). Interfaces with a provider group by it;
 *  the rest group by link type, so nothing is lost. */
function buildLinkGroups(interfaces: NetworkInterface[], cfg: AdapterConfig): LinkGroupState[] {
  const byKey = new Map<string, { label: string; members: NetworkInterface[] }>();
  for (const itf of interfaces) {
    const label = itf.provider ?? (itf.linkType === 'UNKNOWN' ? 'Unclassified' : itf.linkType);
    const key = slug(label) || 'unclassified';
    const entry = byKey.get(key) ?? { label, members: [] };
    entry.members.push(itf);
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([key, { label, members }]) => buildGroup(key, label, members, cfg))
    .sort((a, b) => (b.capacityBps ?? 0) - (a.capacityBps ?? 0));
}

function buildSummary(devices: NetworkDevice[], interfaces: NetworkInterface[], peers: BgpPeer[], snapshotFreshness: Freshness): NetworkSummary {
  // Exclude LAG members from throughput aggregates — the Port-Channel already represents their
  // combined traffic, so counting both would double-count.
  const external = interfaces.filter((i) => EXTERNAL.includes(i.linkType) && i.memberOf === null);
  const peering = interfaces.filter((i) => PEERING.includes(i.linkType) && i.memberOf === null);
  const transit = interfaces.filter((i) => i.linkType === 'TRANSIT' && i.memberOf === null);
  const totalEdge = sumOrNull(external.map((i) => i.primaryBps));
  const operationalCapacity = sumOrNull(external.filter((i) => i.operState === 'up').map((i) => i.speedBps));
  const operationalHeadroom = totalEdge !== null && operationalCapacity !== null ? Math.max(0, operationalCapacity - totalEdge) : null;
  const unhealthy = (s: HealthStatus) => s === 'warning' || s === 'critical' || s === 'down';
  return {
    totalEdgeThroughputBps: totalEdge,
    totalPeeringThroughputBps: sumOrNull(peering.map((i) => i.primaryBps)),
    totalTransitThroughputBps: sumOrNull(transit.map((i) => i.primaryBps)),
    operationalCapacityBps: operationalCapacity,
    operationalHeadroomBps: operationalHeadroom,
    unhealthyLinks: external.filter((i) => unhealthy(i.status)).length,
    unhealthyBgpPeers: peers.filter((p) => unhealthy(p.status)).length,
    deviceCount: devices.length,
    interfaceCount: interfaces.length,
    unknownInterfaceCount: interfaces.filter((i) => i.linkType === 'UNKNOWN').length,
    telemetryAgeSeconds: snapshotFreshness.ageSeconds,
  };
}

function buildCompleteness(expected: number, devices: NetworkDevice[], interfaces: NetworkInterface[]): Completeness {
  const observedDevices = devices.filter((d) => d.observedAt !== null).length;
  const interfacesWithBandwidth = interfaces.filter((i) => i.primaryBps !== null).length;
  const totalInterfaces = interfaces.length;
  let level: Completeness['level'] = 'partial';
  if (devices.length === 0 && totalInterfaces === 0) level = 'empty';
  else if (observedDevices >= Math.max(expected, 1) && interfacesWithBandwidth === totalInterfaces) level = 'complete';
  return { expectedDevices: expected, observedDevices, interfacesWithBandwidth, totalInterfaces, level };
}

// ---- Entry point ----------------------------------------------------------------------------

/** Build the canonical snapshot from raw observations. Pure and deterministic given `cfg.now`. */
export function buildSnapshot(raw: RawSnapshot, cfg: AdapterConfig): NetworkStateSnapshot {
  const provenance = provenanceFor(cfg.source, cfg.synthetic);
  const hostById = new Map(raw.devices.map((d) => [d.id, d.hostname]));

  const devices = raw.devices.map((d) => buildDevice(d, cfg));
  const interfaces = raw.interfaces.map((i) =>
    buildInterface(i, raw.previousCounters?.get(counterKey(i.deviceId, i.name)), hostById.get(i.deviceId) ?? i.deviceId, cfg),
  );
  const bgpPeers = raw.bgpPeers.map((p) => buildBgpPeer(p, hostById.get(p.deviceId) ?? p.deviceId, cfg));
  const linkGroups = buildLinkGroups(interfaces, cfg);

  const snapshotFreshness = aggregateFreshness(devices.map((d) => d.freshness), cfg.now, cfg.staleAfterSeconds);
  const summary = buildSummary(devices, interfaces, bgpPeers, snapshotFreshness);
  const completeness = buildCompleteness(cfg.expectedDeviceIds.length, devices, interfaces);

  // Snapshot-level warnings (honest surfacing; never silent).
  const warnings: string[] = [];
  const missing = cfg.expectedDeviceIds.filter((id) => !raw.devices.some((d) => d.id === id));
  if (missing.length > 0) warnings.push(`${missing.length} configured edge device(s) missing from CloudVision: ${missing.join(', ')}.`);
  if (summary.unknownInterfaceCount > 0) warnings.push(`${summary.unknownInterfaceCount} interface(s) are unclassified (UNKNOWN link type).`);
  if (snapshotFreshness.level === 'STALE' || snapshotFreshness.level === 'UNAVAILABLE') warnings.push('Snapshot telemetry is stale or unavailable; do not treat as current.');
  if (summary.unhealthyBgpPeers > 0) warnings.push(`${summary.unhealthyBgpPeers} BGP peer(s) are not established.`);

  return {
    capturedAt: new Date(cfg.now).toISOString(),
    source: cfg.source,
    devices,
    interfaces,
    bgpPeers,
    linkGroups,
    summary,
    freshness: snapshotFreshness,
    completeness,
    warnings,
    provenance,
  };
}

/** An empty snapshot for a disabled/failed connector — honest "not connected", never invented. */
export function emptySnapshot(cfg: Pick<AdapterConfig, 'source' | 'synthetic' | 'now' | 'staleAfterSeconds' | 'expectedDeviceIds'>): NetworkStateSnapshot {
  const full: AdapterConfig = { ...cfg, classificationRules: [], warningPercent: 80, criticalPercent: 90 };
  return buildSnapshot({ devices: [], interfaces: [], bgpPeers: [] }, full);
}

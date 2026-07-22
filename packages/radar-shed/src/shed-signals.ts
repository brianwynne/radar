// Shed-signal core — per-(ISP × datacentre) egress utilisation mapped through the per-ISP shed_load
// watermarks, to model the load-shedding signals RADAR would feed to NS1's shed_load filter. Pure and
// STANDALONE: no DB/HTTP/Fastify/React deps and no import from the RADAR app, so this same code runs
// inside RADAR (the realtime view) AND in an independent resilient service (the future feed-pusher).
// The gating (`shedFraction`) mirrors the NS1/engine shed_load approximation so both agree exactly.

/** The minimal interface shape the shed core needs. RADAR's CloudVision `NetworkInterface` is a
 *  superset and is structurally assignable to this — so the app passes its interfaces directly. */
export type ShedLinkType = 'PRIVATE_PEERING' | 'IX_PEERING' | 'TRANSIT' | 'INTERNAL' | 'UNKNOWN';
export interface ShedInterface {
  deviceId: string;
  name: string;
  provider: string | null;
  linkType: ShedLinkType;
  /** Configured capacity in bits/sec (null if unknown). */
  speedBps: number | null;
  /** Egress (delivery-direction) throughput in bits/sec (null if unavailable). */
  primaryBps: number | null;
}

export type DcId = 'citywest' | 'parkwest';
export interface Datacentre { id: DcId; name: string; deviceId: string }

// The two WAN-edge routers = the two delivery datacentres (serials from the RTÉ CVaaS tenant).
export const DATACENTRES: readonly Datacentre[] = [
  { id: 'citywest', name: 'Citywest', deviceId: 'JPN2508A7QM' },
  { id: 'parkwest', name: 'Parkwest', deviceId: 'JPA2430A9R2' },
];

export interface Watermark { low: number; high: number }

export interface ShedIsp {
  id: string;
  name: string;
  asn: number | null;
  /** Case-insensitive substrings identifying this ISP on an interface `provider` (from the device
   *  description, e.g. "Liberty Global" matches "liberty"). Unused for INEX (matched by link type). */
  providerMatch: string[];
  /** Datacentres where this ISP has an ACTIVE delivery PNI (ground truth: Three is Citywest-only —
   *  its Parkwest PNI is configured but dead). Empty ⇒ no dedicated PNI. */
  activeDcs: DcId[];
  /** True ⇒ this ISP has no usable PNI and rides the shared INEX IX port; its shed feed = INEX util. */
  viaInex?: boolean;
  /** True ⇒ this row IS the shared INEX IX port itself (matched by IX_PEERING link type). */
  isInex?: boolean;
  /** Default shed_load watermarks (low/high egress util %). The UI can override per-ISP. */
  watermark: Watermark;
}

// Grounded defaults from the liveshed design work (capacity-weighted: Liberty tightest at 40G/DC).
export const SHED_ISPS: readonly ShedIsp[] = [
  { id: 'eir', name: 'Eir', asn: 5466, providerMatch: ['eir'], activeDcs: ['citywest', 'parkwest'], watermark: { low: 78, high: 90 } },
  { id: 'sky', name: 'Sky', asn: 5607, providerMatch: ['sky'], activeDcs: ['citywest', 'parkwest'], watermark: { low: 70, high: 85 } },
  { id: 'three', name: 'Three', asn: 13280, providerMatch: ['three'], activeDcs: ['citywest'], watermark: { low: 65, high: 82 } },
  { id: 'liberty', name: 'Liberty / Virgin', asn: 6830, providerMatch: ['liberty', 'virgin', 'ntl'], activeDcs: ['citywest', 'parkwest'], watermark: { low: 55, high: 75 } },
  { id: 'vodafone', name: 'Vodafone', asn: 15502, providerMatch: ['vodafone'], activeDcs: [], viaInex: true, watermark: { low: 75, high: 90 } },
  { id: 'inex', name: 'INEX (IX)', asn: null, providerMatch: ['inex'], activeDcs: ['citywest', 'parkwest'], isInex: true, watermark: { low: 75, high: 90 } },
];

export type ShedState = 'serve' | 'partial' | 'shed' | 'no-data';

/** NS1 shed_load gating: the FRACTION of queries the Réalta answer would be dropped for. 0 at/below
 *  the low watermark, a linear ramp low→high (NS1's mid-band curve is unpublished ≈ proportional), 1
 *  at/above high. Mirrors the engine's shed_load approximation. */
export function shedFraction(utilPercent: number | null, low: number, high: number): number | null {
  if (utilPercent === null) return null;
  if (!(high > low)) return utilPercent >= high ? 1 : 0;
  if (utilPercent <= low) return 0;
  if (utilPercent >= high) return 1;
  return (utilPercent - low) / (high - low);
}

export function shedState(utilPercent: number | null, wm: Watermark): ShedState {
  if (utilPercent === null) return 'no-data';
  if (utilPercent >= wm.high) return 'shed';
  if (utilPercent > wm.low) return 'partial';
  return 'serve';
}

export interface ShedCell {
  dc: DcId;
  /** Whether this ISP has an active PNI in this DC (false ⇒ rendered as "no PNI"). */
  active: boolean;
  capacityBps: number | null;
  primaryBps: number | null;
  utilisationPercent: number | null;
  interfaceNames: string[];
}

export interface ShedSignalIsp {
  id: string;
  name: string;
  asn: number | null;
  viaInex: boolean;
  isInex: boolean;
  watermark: Watermark;
  cells: ShedCell[];
  /** Combined across the ISP's DCs (the feed for the 180s apex spill). For a viaInex ISP this is the
   *  shared INEX combined util. */
  combined: { capacityBps: number | null; primaryBps: number | null; utilisationPercent: number | null };
}

export interface DatacentreUtil {
  id: DcId;
  name: string;
  /** Total egress across the DC's delivery interfaces (PNI + IX). */
  egressBps: number | null;
  capacityBps: number | null;
  utilisationPercent: number | null;
}

export interface ShedSignals {
  datacentres: DatacentreUtil[];
  isps: ShedSignalIsp[];
}

const providerMatches = (provider: string | null, matches: string[]): boolean =>
  provider !== null && matches.some((m) => provider.toLowerCase().includes(m));

/** The peering/IX interfaces this ISP is carried on at a given device (egress-delivery links only). */
function matchInterfaces(isp: ShedIsp, deviceId: string, interfaces: ShedInterface[]): ShedInterface[] {
  return interfaces.filter((i) => {
    if (i.deviceId !== deviceId) return false;
    if (isp.isInex) return i.linkType === 'IX_PEERING';
    return i.linkType === 'PRIVATE_PEERING' && providerMatches(i.provider, isp.providerMatch);
  });
}

/** Total-throughput / total-capacity for a set of interfaces — NEVER an average of percentages. */
function aggregate(ifaces: ShedInterface[]): { capacityBps: number | null; primaryBps: number | null; utilisationPercent: number | null; interfaceNames: string[] } {
  const withCapacity = ifaces.filter((i) => i.speedBps && i.speedBps > 0);
  const capacityBps = withCapacity.length ? withCapacity.reduce((s, i) => s + (i.speedBps ?? 0), 0) : null;
  const withBps = ifaces.filter((i) => i.primaryBps !== null);
  const primaryBps = withBps.length ? withBps.reduce((s, i) => s + (i.primaryBps ?? 0), 0) : null;
  const utilisationPercent = capacityBps && capacityBps > 0 && primaryBps !== null ? Math.round((primaryBps / capacityBps) * 1000) / 10 : null;
  return { capacityBps, primaryBps, utilisationPercent, interfaceNames: ifaces.map((i) => i.name) };
}

/** Build the per-(ISP × DC) shed signals from CloudVision interfaces. Pure: the raw util is fully
 *  computed here; gating (shedFraction/shedState) is applied by the caller so the watermarks stay
 *  adjustable in the UI without a round-trip. */
export function buildShedSignals(interfaces: ShedInterface[], policy: readonly ShedIsp[] = SHED_ISPS): ShedSignals {
  // Compute INEX combined first — a viaInex ISP's feed is the shared INEX util.
  const inexPolicy = policy.find((p) => p.isInex);
  const inexCombined = inexPolicy
    ? aggregate(DATACENTRES.flatMap((dc) => matchInterfaces(inexPolicy, dc.deviceId, interfaces)))
    : { capacityBps: null, primaryBps: null, utilisationPercent: null, interfaceNames: [] };

  const isps = policy.map((isp): ShedSignalIsp => {
    const cells: ShedCell[] = DATACENTRES.map((dc) => {
      const active = isp.activeDcs.includes(dc.id);
      if (!active) return { dc: dc.id, active: false, capacityBps: null, primaryBps: null, utilisationPercent: null, interfaceNames: [] };
      const agg = aggregate(matchInterfaces(isp, dc.deviceId, interfaces));
      return { dc: dc.id, active: true, capacityBps: agg.capacityBps, primaryBps: agg.primaryBps, utilisationPercent: agg.utilisationPercent, interfaceNames: agg.interfaceNames };
    });

    const combined = isp.viaInex
      ? { capacityBps: inexCombined.capacityBps, primaryBps: inexCombined.primaryBps, utilisationPercent: inexCombined.utilisationPercent }
      : aggregate(isp.activeDcs.flatMap((dcId) => {
          const dc = DATACENTRES.find((d) => d.id === dcId)!;
          return matchInterfaces(isp, dc.deviceId, interfaces);
        }));

    return {
      id: isp.id,
      name: isp.name,
      asn: isp.asn,
      viaInex: !!isp.viaInex,
      isInex: !!isp.isInex,
      watermark: isp.watermark,
      cells,
      combined: { capacityBps: combined.capacityBps, primaryBps: combined.primaryBps, utilisationPercent: combined.utilisationPercent },
    };
  });

  // Per-DC utilisation = total egress across the DC's delivery interfaces (PNI + IX) ÷ their capacity.
  // This is the Citywest-vs-Parkwest signal used to correct the CW↔PW load-balancer weight split.
  const datacentres: DatacentreUtil[] = DATACENTRES.map((d) => {
    const agg = aggregate(interfaces.filter((i) => i.deviceId === d.deviceId && (i.linkType === 'PRIVATE_PEERING' || i.linkType === 'IX_PEERING')));
    return { id: d.id, name: d.name, egressBps: agg.primaryBps, capacityBps: agg.capacityBps, utilisationPercent: agg.utilisationPercent };
  });

  return { datacentres, isps };
}

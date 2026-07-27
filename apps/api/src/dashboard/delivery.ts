// Live delivery split for the Dashboard pie: how much content is being delivered right now to each
// eyeball network (via RTÉ's own Réalta CDN, over its eyeball PNIs) and by the commercial CDNs
// (Fastly, Akamai). Read-only-derived from CloudVision + commercial-CDN telemetry. Eyeball delivery
// is the OUTBOUND direction on a PRIVATE_PEERING link whose provider is a known eyeball ISP — the
// same allow-list the Network Telemetry views use (kept in sync with web/src/network/peering.ts).
import type { NetworkInterface, NetworkStateSnapshot } from '../cloudvision/types.js';
import type { FastlySnapshot } from '../fastly/types.js';
import type { AkamaiSnapshot } from '../akamai/types.js';

const EYEBALL = /\b(eir|eircom|vodafone|three|sky|virgin|liberty|digiweb|magnet|imagine|pure ?telecom|bt)\b/i;

export type DeliveryPlatform = 'Réalta' | 'Fastly' | 'Akamai';

export interface DeliverySlice {
  label: string;                       // eyeball provider name, INEX, or the commercial CDN name
  // eyeball = Réalta over a private PNI; ix = Réalta over public IX peering (INEX — carries
  // Vodafone + smaller ISPs); commercial = Fastly/Akamai.
  kind: 'eyeball' | 'ix' | 'commercial';
  platform: DeliveryPlatform;
  /** Sum of the MEASURED live out-bps across every contributing link (not capacity). */
  bps: number;
  /** How many links/services were summed into `bps` — so a multi-link PNI (e.g. Eir 2× PNIs at
   *  different utilisation) is transparent: the value is the sum of each link's real throughput. */
  links: number;
  /** Per-link breakdown (PNI/IX slices only): each contributing link with its delivery throughput,
   *  configured capacity, and delivery utilisation (out-bps ÷ capacity). Lets a 2-link PNI show both
   *  links and each link's real % utilisation, rather than one aggregate figure. */
  linkDetails?: DeliveryLink[];
}

export interface DeliveryLink {
  device: string;
  iface: string;
  bps: number;
  capacityBps: number | null;
  utilisationPercent: number | null;
}

export interface DeliverySplit {
  slices: DeliverySlice[];
  realtaBps: number;
  commercialBps: number;
  totalBps: number;
}

const sumBps = (xs: { bps: number | null | undefined }[]): number =>
  xs.reduce((s, x) => s + (typeof x.bps === 'number' && Number.isFinite(x.bps) && x.bps > 0 ? x.bps : 0), 0);

export function computeDeliverySplit(
  net: NetworkStateSnapshot | null,
  fastly: FastlySnapshot | null,
  akamai: AkamaiSnapshot | null,
): DeliverySplit {
  // Groups the contributing links (Port-Channels; LAG members excluded) per key, so each slice is
  // the SUM of each link's MEASURED out-bps and can expose the per-link utilisation.
  const groupLinks = (predicate: (linkType: string) => boolean, keyOf: (provider: string | null, name: string) => string) => {
    const g = new Map<string, NetworkInterface[]>();
    for (const i of net?.interfaces ?? []) {
      if (i.memberOf !== null) continue;               // count the Port-Channel, not its members
      if (!predicate(i.linkType)) continue;
      if ((i.outBps ?? 0) <= 0) continue;
      const key = keyOf(i.provider, i.name);
      if (!key) continue;                              // didn't match the allow-list
      const list = g.get(key);
      if (list) list.push(i); else g.set(key, [i]);
    }
    return g;
  };

  const linkDetail = (i: NetworkInterface): DeliveryLink => ({
    device: i.deviceHostname,
    iface: i.name,
    bps: i.outBps ?? 0,
    capacityBps: i.speedBps,
    // Delivery utilisation = outbound bit-rate ÷ configured capacity (the delivery direction).
    utilisationPercent: i.speedBps && i.speedBps > 0 ? ((i.outBps ?? 0) / i.speedBps) * 100 : null,
  });
  const sliceFrom = (label: string, kind: 'eyeball' | 'ix', ifaces: NetworkInterface[]): DeliverySlice => ({
    label, kind, platform: 'Réalta',
    bps: ifaces.reduce((s, i) => s + (i.outBps ?? 0), 0),
    links: ifaces.length,
    linkDetails: ifaces.map(linkDetail).sort((a, b) => b.bps - a.bps),
  });

  // Réalta eyeball delivery: eyeball PNIs grouped by provider (Eir, Sky, …).
  const byEyeball = groupLinks((lt) => lt === 'PRIVATE_PEERING', (provider, name) => (EYEBALL.test(provider ?? name) ? (provider ?? name) : ''));
  const eyeballSlices: DeliverySlice[] = [...byEyeball.entries()]
    .map(([label, ifaces]) => sliceFrom(label, 'eyeball', ifaces))
    .sort((a, b) => b.bps - a.bps);

  // Réalta delivery over PUBLIC IX peering (INEX) — the exchange LAN aggregates many peers
  // (Vodafone + smaller ISPs), so it can't be split per-ISP; shown as one slice, kept distinct.
  const byIx = groupLinks((lt) => lt === 'IX_PEERING', (provider) => provider ?? 'INEX');
  const ixSlices: DeliverySlice[] = [...byIx.entries()]
    .map(([label, ifaces]) => sliceFrom(label, 'ix', ifaces))
    .sort((a, b) => b.bps - a.bps);

  const fastlyServices = (fastly?.services ?? []).filter((s) => (s.bandwidthBps ?? 0) > 0);
  const akamaiServices = (akamai?.series ?? []).filter((s) => (s.bandwidthBps ?? 0) > 0);
  const fastlyBps = sumBps(fastlyServices.map((s) => ({ bps: s.bandwidthBps })));
  const akamaiBps = sumBps(akamaiServices.map((s) => ({ bps: s.bandwidthBps })));
  const commercialSlices: DeliverySlice[] = [];
  if (fastlyBps > 0) commercialSlices.push({ label: 'Fastly', kind: 'commercial', platform: 'Fastly', bps: fastlyBps, links: fastlyServices.length });
  if (akamaiBps > 0) commercialSlices.push({ label: 'Akamai', kind: 'commercial', platform: 'Akamai', bps: akamaiBps, links: akamaiServices.length });

  // Réalta delivery = private PNI (per eyeball) + public IX peering (INEX).
  const realtaBps = [...eyeballSlices, ...ixSlices].reduce((s, x) => s + x.bps, 0);
  const commercialBps = fastlyBps + akamaiBps;
  return {
    slices: [...eyeballSlices, ...ixSlices, ...commercialSlices],
    realtaBps,
    commercialBps,
    totalBps: realtaBps + commercialBps,
  };
}

// Live delivery split for the Dashboard pie: how much content is being delivered right now to each
// eyeball network (via RTÉ's own Réalta CDN, over its eyeball PNIs) and by the commercial CDNs
// (Fastly, Akamai). Read-only-derived from CloudVision + commercial-CDN telemetry. Eyeball delivery
// is the OUTBOUND direction on a PRIVATE_PEERING link whose provider is a known eyeball ISP — the
// same allow-list the Network Telemetry views use (kept in sync with web/src/network/peering.ts).
import type { NetworkStateSnapshot } from '../cloudvision/types.js';
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
  bps: number;
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
  // Réalta eyeball delivery: outbound bit-rate on each eyeball PNI, grouped by provider.
  const byEyeball = new Map<string, number>();
  for (const i of net?.interfaces ?? []) {
    if (i.memberOf !== null) continue;                 // count the Port-Channel, not its members
    if (i.linkType !== 'PRIVATE_PEERING') continue;    // eyeball PNI only
    const name = i.provider ?? i.name;
    if (!EYEBALL.test(name)) continue;
    const bps = i.outBps ?? 0;                          // delivery = RTÉ → eyeball (outbound)
    if (bps <= 0) continue;
    const key = i.provider ?? name;
    byEyeball.set(key, (byEyeball.get(key) ?? 0) + bps);
  }
  const eyeballSlices: DeliverySlice[] = [...byEyeball.entries()]
    .map(([label, bps]) => ({ label, kind: 'eyeball' as const, platform: 'Réalta' as const, bps }))
    .sort((a, b) => b.bps - a.bps);

  // Réalta delivery over PUBLIC IX peering (INEX) — the exchange LAN aggregates many peers
  // (Vodafone + smaller ISPs), so it can't be split per-ISP; shown as one slice, kept distinct
  // from the private PNIs.
  const byIx = new Map<string, number>();
  for (const i of net?.interfaces ?? []) {
    if (i.memberOf !== null) continue;
    if (i.linkType !== 'IX_PEERING') continue;
    const bps = i.outBps ?? 0;
    if (bps <= 0) continue;
    const key = i.provider ?? 'INEX';
    byIx.set(key, (byIx.get(key) ?? 0) + bps);
  }
  const ixSlices: DeliverySlice[] = [...byIx.entries()]
    .map(([label, bps]) => ({ label, kind: 'ix' as const, platform: 'Réalta' as const, bps }))
    .sort((a, b) => b.bps - a.bps);

  const fastlyBps = sumBps((fastly?.services ?? []).map((s) => ({ bps: s.bandwidthBps })));
  const akamaiBps = sumBps((akamai?.series ?? []).map((s) => ({ bps: s.bandwidthBps })));
  const commercialSlices: DeliverySlice[] = [];
  if (fastlyBps > 0) commercialSlices.push({ label: 'Fastly', kind: 'commercial', platform: 'Fastly', bps: fastlyBps });
  if (akamaiBps > 0) commercialSlices.push({ label: 'Akamai', kind: 'commercial', platform: 'Akamai', bps: akamaiBps });

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

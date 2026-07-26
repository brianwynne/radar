// Shared peering/transit link classification for the Network Telemetry views. Kept in one place so
// the OTT Delivery tab and the capacity panels agree on what counts as an eyeball PNI.
import type { NetworkInterface } from '../api/types';

export const isPni = (i: NetworkInterface): boolean => i.linkType === 'PRIVATE_PEERING';
export const isIx = (i: NetworkInterface): boolean => i.linkType === 'IX_PEERING';

// Eyeball / audience ISPs whose PNIs carry OTT delivery. An allow-list so only genuine eyeball
// peering counts as "eyeball" — transit, IX and any mislabelled PRIVATE_PEERING are excluded.
export const EYEBALL = /\b(eir|eircom|vodafone|three|sky|virgin|liberty|digiweb|magnet|imagine|pure ?telecom|bt)\b/i;

export const isEyeballPni = (i: NetworkInterface): boolean => isPni(i) && EYEBALL.test(i.provider ?? i.name);

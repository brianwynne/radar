// Helpers for the enhanced NS1 record "Config" view: translate NS1's raw labels into human
// terms (country code → country name, filter type → plain-language behaviour), summarise long
// lists ("all countries except IE, GB"), and compute weight shares. Display-only; the engine
// stays authoritative for steering. ASN → owner translation reuses the ASN-breakdown route.

// ISO 3166-1 alpha-2 codes, used ONLY to compute the complement for an "all countries except …"
// summary. Names are rendered via Intl.DisplayNames (no name table shipped).
export const ISO_ALPHA2: string[] = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW',
];
const ISO_SET = new Set(ISO_ALPHA2);

let regionNames: Intl.DisplayNames | null | undefined;
function displayNames(): Intl.DisplayNames | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    } catch {
      regionNames = null;
    }
  }
  return regionNames;
}

/** Country code → English name (e.g. "IE" → "Ireland"). Falls back to the code itself. */
export function countryName(code: string): string {
  const c = code.trim().toUpperCase();
  try {
    return displayNames()?.of(c) ?? c;
  } catch {
    return c;
  }
}

export interface CountrySummary {
  codes: string[];
  /** Present when the list is "all countries except a few" — the excluded codes. */
  excluded: string[] | null;
  /** Human phrase: "All countries except Ireland, United Kingdom" or "3 countries". */
  phrase: string;
}

/** Summarise a country list. When it covers nearly every ISO country, phrase it as the small
 *  complement ("all except …"); otherwise give the count. Callers still show the full list. */
export function summariseCountries(codes: string[]): CountrySummary {
  const norm = codes.map((c) => c.trim().toUpperCase()).filter(Boolean);
  const set = new Set(norm);
  const excluded = ISO_ALPHA2.filter((c) => !set.has(c));
  const coversMost = set.size >= Math.floor(ISO_SET.size * 0.85) && norm.every((c) => ISO_SET.has(c));
  if (coversMost && excluded.length > 0 && excluded.length <= 12) {
    return { codes: norm, excluded, phrase: `All countries except ${excluded.map(countryName).join(', ')}` };
  }
  if (excluded.length === 0 && norm.length > 0) {
    return { codes: norm, excluded: [], phrase: 'All countries' };
  }
  const shown = norm.slice(0, 3).map(countryName).join(', ');
  return { codes: norm, excluded: null, phrase: norm.length <= 3 ? shown : `${norm.length} countries` };
}

// --- Filter chain: NS1 filter type → label + plain-language behaviour + support in RADAR. ---
export type FilterBehaviour = 'eliminate' | 'reorder' | 'select' | 'modify' | 'group' | 'unknown';
export interface FilterMeta {
  label: string;
  behaviour: FilterBehaviour;
  description: string;
  /** RADAR's engine evaluates this filter type; unsupported ones fall back to partial evaluation. */
  supported: boolean;
}

const FILTERS: Record<string, FilterMeta> = {
  up: { label: 'Up', behaviour: 'eliminate', supported: true, description: 'Removes answers marked down (by health check or data feed).' },
  geofence_country: { label: 'Geofence Country', behaviour: 'eliminate', supported: true, description: "Keeps answers tagged with the client's country; when any country matches, untagged/other-country answers are dropped." },
  geofence_regional: { label: 'Geofence Regional', behaviour: 'eliminate', supported: true, description: "Keeps answers tagged with the client's region; drops non-matching when any region matches." },
  netfence_asn: { label: 'Netfence ASN', behaviour: 'eliminate', supported: true, description: "Keeps answers tagged with the client's network (ASN); when any ASN matches, untagged answers are dropped." },
  netfence_prefix: { label: 'Netfence Prefix', behaviour: 'eliminate', supported: true, description: "Keeps answers tagged with the client's IP prefix; drops non-matching when any prefix matches." },
  geotarget_country: { label: 'Geotarget Country', behaviour: 'reorder', supported: true, description: "Sorts answers by proximity to the client's country (no elimination)." },
  weighted_shuffle: { label: 'Weighted Shuffle', behaviour: 'reorder', supported: true, description: 'Randomly orders the remaining answers, biased by their weight — higher weight ⇒ more likely first.' },
  shuffle: { label: 'Shuffle', behaviour: 'reorder', supported: false, description: 'Randomly orders the remaining answers (equal probability).' },
  select_first_n: { label: 'Select First N', behaviour: 'select', supported: true, description: 'Keeps only the first N answers after the preceding filters (N=1 ⇒ a single served answer).' },
  select_first_group: { label: 'Select First Group', behaviour: 'group', supported: false, description: 'Keeps only answers in the first surviving answer group.' },
  priority: { label: 'Priority', behaviour: 'select', supported: false, description: 'Selects answers by ascending priority tier.' },
  sticky: { label: 'Sticky', behaviour: 'reorder', supported: false, description: 'Consistently orders answers per client so repeat lookups are stable.' },
  shed_load: { label: 'Shed Load', behaviour: 'eliminate', supported: false, description: 'Sheds answers by load watermark to protect overloaded targets.' },
};

export function filterMeta(type: string): FilterMeta {
  return FILTERS[type] ?? { label: type.replace(/_/g, ' '), behaviour: 'unknown', supported: false, description: 'Unrecognised filter — RADAR falls back to partial evaluation for records using it.' };
}

// --- NS1 meta extraction (values may be scalar, array, or a {feed} pointer). ---
export function isFeedPtr(v: unknown): v is { feed: string } {
  return typeof v === 'object' && v !== null && 'feed' in (v as Record<string, unknown>);
}

export function asnList(meta: unknown): number[] {
  const asn = (meta as { asn?: unknown } | null)?.asn;
  if (Array.isArray(asn)) return asn.map(Number).filter((n) => Number.isFinite(n));
  if (typeof asn === 'number') return [asn];
  return [];
}

export function countryList(meta: unknown): string[] {
  const c = (meta as { country?: unknown } | null)?.country;
  if (Array.isArray(c)) return c.map((x) => String(x));
  if (typeof c === 'string') return [c];
  return [];
}

/** Each answer's share of the total weight (0–1), for the weighted-shuffle split. */
export function weightShares<T extends { weight: number }>(items: T[]): (T & { share: number })[] {
  const total = items.reduce((s, i) => s + (i.weight > 0 ? i.weight : 0), 0);
  return items.map((i) => ({ ...i, share: total > 0 && i.weight > 0 ? i.weight / total : 0 }));
}

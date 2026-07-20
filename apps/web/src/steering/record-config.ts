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

// --- Filter chain: NS1 filter type → label, category, a short summary, and NS1's OWN
// authoritative description (verbatim from IBM NS1 Connect) where captured. Categories +
// behaviour icons come from NS1's "Create a Filter Chain" catalogue. ---
export type FilterBehaviour = 'eliminate' | 'reorder' | 'select' | 'modify' | 'group' | 'unknown';
// NS1's filter categories (from the filter-chain builder).
export type FilterCategory = 'Geographic' | 'Fencing' | 'Health checks' | 'Traffic Management' | 'Other' | 'Pulsar';
export interface FilterMeta {
  label: string;
  category: FilterCategory | null;
  behaviour: FilterBehaviour;
  /** RADAR's own plain-language one-liner (always shown, clearly attributed to RADAR). */
  summary: string;
  /** NS1's OWN verbatim description — present ONLY for filters whose text we have captured from
   *  NS1 directly. RADAR never fabricates NS1 wording; when this is absent, only the RADAR
   *  summary is shown. */
  ns1Description?: string;
  /** RADAR's engine evaluates this filter type; unsupported ones fall back to partial evaluation. */
  supported: boolean;
}

// `ns1Description` holds NS1's OWN verbatim text — set ONLY for filters captured directly from
// NS1's UI. All other `summary` lines are RADAR's plain-language interpretation of the documented
// filter type; the UI attributes them to RADAR and never presents them as NS1's wording.
const FILTERS: Record<string, FilterMeta> = {
  // --- Health checks ---
  up: {
    label: 'Up', category: 'Health checks', behaviour: 'eliminate', supported: true,
    summary: 'Removes answers marked down (by the up metadata field or a connected feed / monitor).',
  },
  shed_load: {
    label: 'Shed Load', category: 'Health checks', behaviour: 'eliminate', supported: false,
    summary: 'Sheds answers by a load watermark (from a connected feed) to protect overloaded targets.',
  },
  // --- Fencing ---
  geofence_country: {
    label: 'Geofence Country', category: 'Fencing', behaviour: 'eliminate', supported: true,
    summary: "Keeps answers whose country metadata matches the requester's country; answers with no country are kept unless 'remove on match' is set.",
  },
  geofence_regional: {
    label: 'Geofence Regional', category: 'Fencing', behaviour: 'eliminate', supported: true,
    summary: "Keeps answers whose georegion matches the requester's region; answers with no georegion are kept unless 'remove on match' is set.",
  },
  netfence_asn: {
    label: 'Netfence ASN', category: 'Fencing', behaviour: 'eliminate', supported: true,
    summary: "Keeps answers whose asn list includes the requester's AS; answers with no asn are kept unless 'remove on match' is set.",
    ns1Description:
      "This filter eliminates answers where the Autonomous System (AS) of the requester's IP does not match the list of AS numbers associated with the answer. It examines the asn metadata field to get the allowed ASes for your answers, and the AS of the requester's IP is matched against the AS list to ensure IPs in their AS are allowed to receive the answer. Optionally, if no asn value is set for an answer, this filter will not eliminate the answer. For example, if your record has one answer with asn=[2914, 3257], and another answer with no value for asn, a request from an IP in AS2914 will receive both answers; a request from an IP in AS701 will receive only the second answer. If instead you want the request from AS2914 to receive only the first answer, enable the \"Remove answers without asn on match\" option. Do not rely on this filter for security purposes.",
  },
  netfence_prefix: {
    label: 'Netfence Prefix', category: 'Fencing', behaviour: 'eliminate', supported: true,
    summary: "Keeps answers whose ip_prefixes include the requester's IP; answers with no ip_prefixes are kept unless 'remove on match' is set.",
    ns1Description:
      "This filter eliminates answers where the requester's IP does not match the IP prefix list associated with the answer. It examines the ip_prefixes metadata field to get the allowed prefix(es) for your answers, and the requester's IP is matched against the prefix lists to ensure their IP is allowed to receive the answer. Optionally, if no ip_prefixes value is set for an answer, this filter will not eliminate the answer. For example, if your record has one answer with ip_prefixes=[1.2.3.0/24, 2.3.4.0/24], and another answer with no value for ip_prefixes, a request from 1.2.3.4 will receive both answers; a request from 5.6.7.8 will receive only the second answer. If instead you want the request from 1.2.3.4 to receive only the first answer, enable the \"Remove answers without ip_prefixes on match\" option. Do not rely on this filter for security purposes.",
  },
  // --- Geographic (reorder; ↕ in NS1's catalogue) ---
  geotarget_country: {
    label: 'Geotarget Country', category: 'Geographic', behaviour: 'reorder', supported: true,
    summary: "Sorts answers by geographic proximity to the requester's country (reorders, does not eliminate).",
  },
  geotarget_regional: {
    label: 'Geotarget Regional', category: 'Geographic', behaviour: 'reorder', supported: false,
    summary: "Sorts answers by proximity to the requester's georegion (reorders).",
  },
  geotarget_latlong: {
    label: 'Geotarget Latlong', category: 'Geographic', behaviour: 'reorder', supported: false,
    summary: "Sorts answers by great-circle distance from the requester to each answer's lat/long (reorders).",
  },
  // --- Traffic Management ---
  weighted_shuffle: {
    label: 'Weighted Shuffle', category: 'Traffic Management', behaviour: 'reorder', supported: true,
    summary: 'Randomly reorders answers biased by weight — higher weight ⇒ first more often.',
    ns1Description:
      'This filter examines the weight metadata field for all available answers, and reorders the answers by picking them randomly based on their weights until all answers have been randomly reordered. Answers with higher weight will be "first" more often. You can use this filter in conjunction with a filter like SELECT_FIRST_N to return one or more answers with probability proportional to their weights. Need to combine this with "sticky" behavior? Use WEIGHTED_STICKY.',
  },
  select_first_n: {
    label: 'Select First N', category: 'Traffic Management', behaviour: 'select', supported: true,
    summary: 'Keeps only the first N answers (N=1 ⇒ a single served answer).',
    ns1Description: 'This filter eliminates all but the first N answers from the list. Use this with filters like SHUFFLE or WEIGHTED_SHUFFLE to implement round robin or weighted round robin.',
  },
  select_first_group: {
    label: 'Select First Group', category: 'Traffic Management', behaviour: 'group', supported: false,
    summary: 'Keeps only answers in the first surviving answer group.',
  },
  shuffle: {
    label: 'Shuffle', category: 'Traffic Management', behaviour: 'reorder', supported: false,
    summary: 'Randomly reorders the remaining answers with equal probability.',
  },
  cost: {
    label: 'Cost', category: 'Traffic Management', behaviour: 'select', supported: false,
    summary: 'Selects answers by the cost metadata field (lowest cost preferred).',
  },
  priority: {
    label: 'Priority', category: 'Traffic Management', behaviour: 'select', supported: false,
    summary: 'Selects answers by the priority metadata field (lowest number wins).',
  },
  sticky_shuffle: {
    label: 'Sticky Shuffle', category: 'Traffic Management', behaviour: 'reorder', supported: false,
    summary: 'Reorders answers deterministically per requester so repeat lookups are stable.',
  },
  group_sticky_shuffle: {
    label: 'Group Sticky Shuffle', category: 'Traffic Management', behaviour: 'reorder', supported: false,
    summary: 'Sticky shuffle applied at the answer-group level.',
  },
  weighted_sticky_shuffle: {
    label: 'Weighted Sticky Shuffle', category: 'Traffic Management', behaviour: 'reorder', supported: false,
    summary: 'Weighted shuffle with sticky (consistent-per-requester) ordering.',
  },
  // --- Other ---
  additional_metadata: {
    label: 'Additional Metadata', category: 'Other', behaviour: 'modify', supported: false,
    summary: 'Attaches extra metadata to answers (does not eliminate or reorder).',
  },
  // --- Pulsar (advanced) ---
  pulsar_availability_sort: {
    label: 'Pulsar Availability Sort', category: 'Pulsar', behaviour: 'reorder', supported: false,
    summary: 'Reorders answers by Pulsar-measured availability.',
  },
  pulsar_availability_threshold: {
    label: 'Pulsar Availability Threshold', category: 'Pulsar', behaviour: 'eliminate', supported: false,
    summary: 'Eliminates answers whose Pulsar availability is below a threshold.',
  },
  pulsar_performance_sort: {
    label: 'Pulsar Performance Sort', category: 'Pulsar', behaviour: 'reorder', supported: false,
    summary: 'Reorders answers by Pulsar-measured performance (RUM).',
  },
  pulsar_performance_stabilize: {
    label: 'Pulsar Performance Stabilize', category: 'Pulsar', behaviour: 'eliminate', supported: false,
    summary: 'Stabilises Pulsar performance-based selection to avoid flapping.',
  },
};

export function filterMeta(type: string): FilterMeta {
  return FILTERS[type] ?? {
    label: type.replace(/_/g, ' '), category: null, behaviour: 'unknown', supported: false,
    summary: 'Unrecognised filter type — RADAR has no local model for it, so records using it are reported as a partial evaluation.',
  };
}

/** The "remove untagged answers on match" switch for the fence filters — read from the actual
 *  filter config, never assumed. `explainSource` marks whether the explanation is NS1's own
 *  verbatim text (asn/prefix, captured from NS1) or RADAR's plain-language wording. */
export interface RemoveFlag { enabled: boolean; label: string; explain: string; explainSource: 'ns1' | 'radar' }
const REMOVE_FLAGS: Record<string, { keys: string[]; label: string; explain: string; explainSource: 'ns1' | 'radar' }> = {
  netfence_asn: {
    keys: ['remove_no_asn'], explainSource: 'ns1',
    label: 'Remove answers without asn list on any match',
    explain: "If any answers have entries in the asn list matching the requester's AS, then eliminate all answers with no asn list; and if no answers match the requester, return answers with no asn list as fallbacks.",
  },
  netfence_prefix: {
    keys: ['remove_no_ip_prefixes'], explainSource: 'ns1',
    label: 'Remove answers without ip_prefixes on any match',
    explain: 'If any answers have ip_prefixes matching the requester, then eliminate all answers with no ip_prefixes; and if no answers match the requester, return answers with no ip_prefixes as fallbacks.',
  },
  geofence_country: {
    keys: ['remove_no_location', 'remove_no_country'], explainSource: 'radar',
    label: 'Remove answers without a country on match',
    explain: "RADAR's reading (NS1's own text for this option not captured): when any answer's country matches the requester, answers with no country are eliminated; if none match, answers with no country are returned as fallbacks.",
  },
};
const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
export function removeFlagFor(type: string, config: Record<string, unknown> | undefined): RemoveFlag | null {
  const spec = REMOVE_FLAGS[type];
  if (!spec) return null;
  const enabled = spec.keys.some((k) => truthy(config?.[k])); // read from the real config, not assumed
  return { enabled, label: spec.label, explain: spec.explain, explainSource: spec.explainSource };
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

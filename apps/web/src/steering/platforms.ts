// Canonical delivery platforms — colours + RDATA→platform derivation, shared across the
// steering overview and the record config view. The patterns MIRROR the engine's source of
// truth (packages/radar-engine/src/engine.ts) — keep them in step; the backend engine remains
// authoritative for steering decisions, this is for display only.
export const PLATFORM_ORDER = ['Réalta', 'Fastly', 'Akamai', 'CloudFront'] as const;

export const PLATFORM_COLORS: Record<string, string> = {
  Réalta: '#2f855a',
  Fastly: '#dd4b39',
  Akamai: '#2b6cb0',
  CloudFront: '#805ad5',
};

export const colorFor = (p: string): string => PLATFORM_COLORS[p] ?? '#718096';
export const orderOf = (p: string): number => {
  const i = (PLATFORM_ORDER as readonly string[]).indexOf(p);
  return i === -1 ? PLATFORM_ORDER.length : i;
};

// RDATA host → delivery platform. Mirrors engine.ts PLATFORM_PATTERNS.
const PLATFORM_PATTERNS: [RegExp, string][] = [
  [/(^|\.)rte\.ie\.?$/i, 'Réalta'], // RTÉ's own CDN (e.g. liveedge.rte.ie)
  [/\.fastly\.net\.?$/i, 'Fastly'],
  [/\.akamai(zed|edge)?\.net\.?$/i, 'Akamai'],
  [/\.cloudfront\.net\.?$/i, 'CloudFront'],
];

/** The delivery platform an answer's rdata points to, or null when unrecognised. */
export function platformOf(rdata: string): string | null {
  const host = rdata.trim().replace(/\.$/, '');
  for (const [re, platform] of PLATFORM_PATTERNS) if (re.test(host)) return platform;
  return null;
}

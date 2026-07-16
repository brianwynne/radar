// RADAR-owned DEFAULT interface classification + BGP provider mapping for the RTÉ Internet
// edge. These are ILLUSTRATIVE defaults, matched by interface description; a deployment
// overrides them with CLOUDVISION_CLASSIFICATION_FILE (see config.ts). Classification is a
// RADAR configuration concern — the device never dictates a provider/link-type. Ordering
// does not matter: the classifier tries device+interface, then exact description, then regex.
import type { ClassificationRule } from './classification.js';

// Link-type is matched from the interface description; the PROVIDER is parsed from the
// description itself (parseProviderFromDescription), so these rules deliberately don't pin a
// provider string — e.g. "[Transit] Blacknight" classifies TRANSIT with provider "Blacknight",
// and "[Po3] Liberty Global" classifies PRIVATE_PEERING with provider "Liberty Global". A
// deployment can still pin a provider by adding a rule with an explicit `provider`.
export const DEFAULT_CLASSIFICATION_RULES: ClassificationRule[] = [
  // Internal first (a "[PoN] Core:"/switch link must not be read as a provider peering).
  { match: { kind: 'description_regex', pattern: 'core|internal|spine|leaf|ibgp|mlag|switch|backbone|fabric', flags: 'i' }, linkType: 'INTERNAL' },
  { match: { kind: 'description_regex', pattern: '\\btransit\\b|cogent|gtt|telia|lumen|arelion|blacknight|hurricane|zayo|\\bntt\\b|\\btata\\b', flags: 'i' }, linkType: 'TRANSIT', location: 'Dublin' },
  { match: { kind: 'description_regex', pattern: '\\binex\\b|\\bix\\b|linx|de-?cix|ams-?ix', flags: 'i' }, linkType: 'IX_PEERING', location: 'Dublin' },
  { match: { kind: 'description_regex', pattern: '\\beir\\b|liberty|virgin|\\bsky\\b|vodafone|\\bthree\\b|digiweb|\\bbt\\b|pure\\s?telecom|magnet|imagine', flags: 'i' }, linkType: 'PRIVATE_PEERING', location: 'Dublin' },
];

/** Illustrative ASN → provider map for BGP peers (deployment-configured). AS5466 = eir. */
export const DEFAULT_PROVIDER_FOR_ASN: Record<number, string> = {
  5466: 'Eir',
};

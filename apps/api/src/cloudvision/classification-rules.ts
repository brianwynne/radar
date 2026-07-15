// RADAR-owned DEFAULT interface classification + BGP provider mapping for the RTÉ Internet
// edge. These are ILLUSTRATIVE defaults, matched by interface description; a deployment
// overrides them with CLOUDVISION_CLASSIFICATION_FILE (see config.ts). Classification is a
// RADAR configuration concern — the device never dictates a provider/link-type. Ordering
// does not matter: the classifier tries device+interface, then exact description, then regex.
import type { ClassificationRule } from './classification.js';

export const DEFAULT_CLASSIFICATION_RULES: ClassificationRule[] = [
  { match: { kind: 'description_regex', pattern: '\\beir\\b', flags: 'i' }, linkType: 'PRIVATE_PEERING', provider: 'Eir', location: 'Dublin' },
  { match: { kind: 'description_regex', pattern: '\\binex\\b', flags: 'i' }, linkType: 'IX_PEERING', provider: 'INEX', location: 'Dublin' },
  { match: { kind: 'description_regex', pattern: 'liberty|virgin', flags: 'i' }, linkType: 'PRIVATE_PEERING', provider: 'Liberty', location: 'Dublin' },
  { match: { kind: 'description_regex', pattern: 'transit|cogent|gtt|telia|lumen|arelion', flags: 'i' }, linkType: 'TRANSIT', provider: 'Transit', location: 'Dublin' },
  { match: { kind: 'description_regex', pattern: 'core|internal|spine|leaf|ibgp|mlag', flags: 'i' }, linkType: 'INTERNAL' },
];

/** Illustrative ASN → provider map for BGP peers (deployment-configured). AS5466 = eir. */
export const DEFAULT_PROVIDER_FOR_ASN: Record<number, string> = {
  5466: 'Eir',
};

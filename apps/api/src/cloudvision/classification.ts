// Configuration-driven interface classification. RADAR-owned: an interface is bound to a
// provider/location/link-type here, never by the device. Rules are tried most-specific
// first — exact device+interface, then exact description, then description regex — and the
// first match wins. An interface that matches no rule is UNKNOWN and stays fully visible
// (never silently discarded), so operators can see and then classify it.
import type { ClassificationSource, LinkType } from './types.js';

export type ClassificationMatch =
  | { kind: 'device_interface'; deviceId: string; interface: string }
  | { kind: 'description_exact'; description: string }
  | { kind: 'description_regex'; pattern: string; flags?: string };

export interface ClassificationRule {
  match: ClassificationMatch;
  linkType: LinkType;
  provider?: string;
  location?: string;
}

export interface ClassificationInput {
  deviceId: string;
  name: string;
  description: string | null;
}

export interface ClassificationResult {
  linkType: LinkType;
  provider: string | null;
  location: string | null;
  classificationSource: ClassificationSource;
}

/** Most-specific-first ordering. Lower = tried earlier. */
const KIND_PRIORITY: Record<ClassificationMatch['kind'], number> = {
  device_interface: 0,
  description_exact: 1,
  description_regex: 2,
};

const UNKNOWN: ClassificationResult = { linkType: 'UNKNOWN', provider: null, location: null, classificationSource: 'unknown' };

/** Extract the provider NAME from an interface description of the form "[<tag>] <Provider>[ - <ref>]"
 *  (e.g. "[Transit] Blacknight BKIE428007" → "Blacknight"; "[Po3] Liberty Global - PX02282" →
 *  "Liberty Global"; "[Po2] INEX LAN#2 - IE298530" → "INEX"). Strips the leading [tag] and any
 *  trailing circuit-reference tokens. Returns null for internal links (Core/switch) or when no
 *  name is present. Used only to fill in a provider a matched rule didn't pin explicitly. */
export function parseProviderFromDescription(description: string | null): string | null {
  if (!description) return null;
  const body = description.replace(/^\s*\[[^\]]*\]\s*/, '').trim(); // drop a leading [Po7]/[Transit] tag
  if (/^(core|internal|ibgp|mlag|spine|leaf|backbone)\b/i.test(body) || /\bswitch\b/i.test(body)) return null;
  const segment = body.split(/\s+[-–]\s+/)[0].trim(); // text before a " - " circuit ref
  const words: string[] = [];
  for (const w of segment.split(/\s+/)) {
    if (/[0-9#]/.test(w)) break; // a token with a digit/# is a circuit ref/detail, not the name
    words.push(w);
  }
  const provider = words.join(' ').replace(/[.,:;]+$/, '').trim();
  return provider.length > 0 ? provider : null;
}

const sourceOf = (kind: ClassificationMatch['kind']): ClassificationSource =>
  kind === 'device_interface' ? 'device_interface' : kind === 'description_exact' ? 'description_exact' : 'description_regex';

function matches(rule: ClassificationRule, input: ClassificationInput): boolean {
  const m = rule.match;
  switch (m.kind) {
    case 'device_interface':
      return input.deviceId === m.deviceId && input.name === m.interface;
    case 'description_exact':
      return input.description !== null && input.description === m.description;
    case 'description_regex': {
      if (input.description === null) return false;
      try {
        return new RegExp(m.pattern, m.flags).test(input.description);
      } catch {
        // An invalid regex never matches (and is rejected at config-load time).
        return false;
      }
    }
  }
}

/** Classify one interface. Rules are evaluated in specificity order regardless of the order
 *  they were supplied, so a deployment can list them in any order. */
export function classifyInterface(rules: ClassificationRule[], input: ClassificationInput): ClassificationResult {
  const ordered = [...rules].sort((a, b) => KIND_PRIORITY[a.match.kind] - KIND_PRIORITY[b.match.kind]);
  for (const rule of ordered) {
    if (matches(rule, input)) {
      return {
        linkType: rule.linkType,
        // A rule may pin the provider explicitly; otherwise derive the real name from the
        // description (so "[Transit] Blacknight" → "Blacknight", not the "[Transit]" tag).
        provider: rule.provider ?? parseProviderFromDescription(input.description),
        location: rule.location ?? null,
        classificationSource: sourceOf(rule.match.kind),
      };
    }
  }
  return UNKNOWN;
}

/** Validate rule set at load time (compiles every regex). Throws on a bad pattern so a
 *  deployment misconfiguration fails fast rather than silently never-matching. */
export function validateClassificationRules(rules: ClassificationRule[]): void {
  for (const rule of rules) {
    if (rule.match.kind === 'description_regex') {
      try {
        new RegExp(rule.match.pattern, rule.match.flags);
      } catch (err) {
        throw new Error(`Invalid classification regex "${rule.match.pattern}": ${err instanceof Error ? err.message : 'bad pattern'}`, { cause: err });
      }
    }
  }
}

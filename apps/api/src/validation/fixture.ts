// Sanitised fixture CANDIDATE generation. Produces a downloadable, credential-redacted,
// order-preserving structural copy of a live payload with provenance metadata and an explicit
// list of fields requiring operator review. It is NEVER committed automatically and is NEVER
// a drop-in fixture — an operator must review it first.
import { redactDeep, redactedPaths } from './redact.js';
import type { SanitisedFixtureCandidate, ValidationEndpoint, ValidationResult } from './types.js';

export function buildFixtureCandidate(
  raw: unknown,
  endpoint: ValidationEndpoint,
  resourceKey: string,
  mode: string,
  retrievedAt: string,
  rawChecksum: string,
  analysis: Pick<ValidationResult, 'unexpectedFields' | 'unknownMetadataFields' | 'unsupportedFilters' | 'feedControlledMetadataPresent' | 'answerGroupsPresent'>,
): SanitisedFixtureCandidate {
  const reviewRequired: string[] = [];
  for (const f of analysis.unexpectedFields) reviewRequired.push(`unexpected field: ${f}`);
  for (const f of analysis.unknownMetadataFields) reviewRequired.push(`unknown metadata: meta.${f}`);
  for (const f of analysis.unsupportedFilters) reviewRequired.push(`unsupported filter: ${f}`);
  if (analysis.feedControlledMetadataPresent) reviewRequired.push('feed-controlled metadata present — must not be shown as static');
  if (analysis.answerGroupsPresent) reviewRequired.push('answer-group structure present — verify grouping is preserved');
  for (const p of redactedPaths(raw)) reviewRequired.push(`redacted credential-like field: ${p}`);

  return {
    provenance: {
      source: 'ns1',
      mode,
      endpoint,
      resourceKey,
      retrievedAt,
      rawChecksum,
      generatedBy: 'radar-validation',
      warning: 'CANDIDATE ONLY — credential-redacted, requires operator review, and is NOT a committed fixture.',
      reviewRequired,
    },
    payload: redactDeep(raw),
  };
}

// Pure analysis: compare a live NS1 payload against RADAR's runtime wire schemas, the engine
// adapter, and the synthetic fixtures — WITHOUT silently coercing incompatible data into the
// model. Reports schema/adapter compatibility, supported/unsupported filters, unknown/
// unexpected/missing fields, type mismatches, answer-group and feed-controlled metadata
// presence, ECS config, and a structural fixture diff.
import { evaluate, type NS1Record, type Scenario } from '@radar/engine';
import { normaliseRecord } from '../ns1/normalise.js';
import { Ns1ActivityShape, Ns1RecordShape, Ns1ZoneShape, Ns1ZonesListShape } from '../ns1/wire.js';
import { RECORD_LIVE_RTE_IE_A } from '../ns1/fixtures.js';
import type { z } from 'zod';
import type { EcsConfiguration, FieldTypeMismatch, FixtureComparison, OverallStatus, UnsupportedFeature, ValidationEndpoint, ValidationResult } from './types.js';

/** Filters the engine supports (kept in step with the engine REGISTRY). Anything else is
 *  UNSUPPORTED → RADAR reports a partial evaluation rather than guessing. */
export const SUPPORTED_FILTERS = ['up', 'netfence_asn', 'netfence_prefix', 'geotarget_country', 'geofence_country', 'weighted_shuffle', 'select_first_n'];

const KNOWN_RECORD_FIELDS = new Set(['id', 'zone', 'domain', 'type', 'ttl', 'use_client_subnet', 'answers', 'filters', 'regions', 'meta', 'link', 'networks', 'override_ttl', 'override_address_records', 'blocked_tags', 'tags', '_radar_note']);
const KNOWN_ANSWER_FIELDS = new Set(['id', 'answer', 'meta', 'region']);
const KNOWN_META_FIELDS = new Set(['up', 'weight', 'note', 'country', 'asn', 'ip_prefixes', 'georegion', 'latitude', 'longitude', 'pulsar', 'priority', 'connections', 'requests', 'loadavg', 'low_watermark', 'high_watermark', 'subdivisions', 'ca_province', 'us_state', 'in_network', 'out_network']);
const EXPECTED_RECORD_FIELDS = ['domain', 'type', 'answers', 'filters'];
const CRITICAL_FIELDS = new Set(['answers', 'filters']);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Structural type-paths (array indices collapsed to `[]`) → the observed type. */
export function structurePaths(value: unknown, prefix = '', acc: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    if (prefix) acc.set(prefix, 'array');
    for (const el of value) structurePaths(el, `${prefix}[]`, acc);
  } else if (isObj(value)) {
    if (prefix) acc.set(prefix, 'object');
    for (const [k, v] of Object.entries(value)) structurePaths(v, prefix ? `${prefix}.${k}` : k, acc);
  } else if (prefix) {
    acc.set(prefix, typeOf(value));
  }
  return acc;
}

function validate(shape: z.ZodType<unknown>, raw: unknown): { ok: boolean; issues: string[] } {
  const r = shape.safeParse(raw);
  return r.success ? { ok: true, issues: [] } : { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/** Recursively detect a feed-controlled metadata value (shape `{ feed: ... }`). */
function hasFeedControlled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFeedControlled);
  if (isObj(value)) {
    if ('feed' in value && Object.keys(value).length <= 2) return true;
    return Object.values(value).some(hasFeedControlled);
  }
  return false;
}

function detectAnswerGroups(record: Record<string, unknown>): boolean {
  const filters = Array.isArray(record.filters) ? record.filters : [];
  if (filters.some((f) => isObj(f) && typeof f.filter === 'string' && /group/i.test(f.filter))) return true;
  if (isObj(record.regions) && Object.keys(record.regions).length > 0) return true;
  const answers = Array.isArray(record.answers) ? record.answers : [];
  return answers.some((a) => isObj(a) && ('region' in a || (isObj(a.meta) && 'georegion' in a.meta)));
}

function fixtureComparison(raw: unknown): FixtureComparison {
  const fixture = structurePaths(RECORD_LIVE_RTE_IE_A);
  const live = structurePaths(raw);
  const provisionalFixtureFields: string[] = [];
  const liveOnlyFields: string[] = [];
  const typeMismatches: FieldTypeMismatch[] = [];
  for (const [path, t] of fixture) {
    if (!live.has(path)) provisionalFixtureFields.push(path);
    else if (live.get(path) !== t) typeMismatches.push({ path, expected: t, actual: live.get(path) as string });
  }
  for (const path of live.keys()) if (!fixture.has(path)) liveOnlyFields.push(path);
  // The fixture carries a synthetic marker that live never will — not a meaningful mismatch.
  const provisional = provisionalFixtureFields.filter((p) => p !== '_radar_note');
  return {
    provisionalFixtureFields: provisional,
    liveOnlyFields,
    typeMismatches,
    matches: provisional.length === 0 && liveOnlyFields.length === 0 && typeMismatches.length === 0,
  };
}

interface Analysis {
  schemaCompatible: boolean;
  schemaIssues: string[];
  adapterCompatible: boolean;
  supportedFilters: string[];
  unsupportedFilters: string[];
  unknownMetadataFields: string[];
  unexpectedFields: string[];
  missingExpectedFields: string[];
  fieldTypeMismatches: FieldTypeMismatch[];
  unsupportedFeatures: UnsupportedFeature[];
  answerGroupsPresent: boolean;
  feedControlledMetadataPresent: boolean;
  ecs: EcsConfiguration;
  fixtureComparison: FixtureComparison;
  warnings: string[];
}

function analyseRecord(raw: unknown): Analysis {
  const warnings: string[] = [];
  const schema = validate(Ns1RecordShape, raw);
  const record = isObj(raw) ? raw : {};
  const answers = Array.isArray(record.answers) ? record.answers : [];
  const filters = Array.isArray(record.filters) ? record.filters : [];

  // Supported / unsupported filters (order preserved).
  const supportedFilters: string[] = [];
  const unsupportedFilters: string[] = [];
  const unsupportedFeatures: UnsupportedFeature[] = [];
  for (const f of filters) {
    const name = isObj(f) && typeof f.filter === 'string' ? f.filter : '(malformed)';
    if (SUPPORTED_FILTERS.includes(name)) supportedFilters.push(name);
    else {
      unsupportedFilters.push(name);
      unsupportedFeatures.push({ kind: 'filter', name, detail: `Filter "${name}" is not in the RADAR engine registry; evaluation is partial beyond it.` });
    }
  }

  // Unknown metadata fields (union across answers).
  const unknownMeta = new Set<string>();
  for (const a of answers) {
    if (isObj(a) && isObj(a.meta)) for (const k of Object.keys(a.meta)) if (!KNOWN_META_FIELDS.has(k)) unknownMeta.add(k);
  }
  for (const name of unknownMeta) unsupportedFeatures.push({ kind: 'metadata', name, detail: `Answer metadata field "${name}" is not modelled by RADAR (preserved, not interpreted).` });

  // Unexpected top-level + answer-level fields.
  const unexpected: string[] = [];
  for (const k of Object.keys(record)) if (!KNOWN_RECORD_FIELDS.has(k)) unexpected.push(k);
  for (const a of answers) if (isObj(a)) for (const k of Object.keys(a)) if (!KNOWN_ANSWER_FIELDS.has(k)) unexpected.push(`answers[].${k}`);

  // Missing expected fields.
  const missing = EXPECTED_RECORD_FIELDS.filter((f) => !(f in record));

  // Field-type mismatches (present but wrong type).
  const mismatches: FieldTypeMismatch[] = [];
  const check = (path: string, value: unknown, expected: string) => {
    if (value !== undefined && typeOf(value) !== expected) mismatches.push({ path, expected, actual: typeOf(value) });
  };
  check('ttl', record.ttl, 'number');
  check('use_client_subnet', record.use_client_subnet, 'boolean');
  check('answers', record.answers, 'array');
  check('filters', record.filters, 'array');
  answers.forEach((a, i) => {
    if (isObj(a)) {
      check(`answers[${i}].answer`, a.answer, 'array');
      if (a.meta !== undefined) check(`answers[${i}].meta`, a.meta, 'object');
      if (isObj(a.meta)) {
        check(`answers[${i}].meta.weight`, a.meta.weight, 'number');
        check(`answers[${i}].meta.asn`, a.meta.asn, 'array');
        check(`answers[${i}].meta.country`, a.meta.country, 'array');
        check(`answers[${i}].meta.ip_prefixes`, a.meta.ip_prefixes, 'array');
      }
    }
  });

  // Adapter compatibility: can the engine normalise + evaluate without throwing?
  let adapterCompatible = true;
  try {
    const rec = normaliseRecord(raw) as NS1Record;
    const scenario: Scenario = { qname: String(record.domain ?? 'live.rte.ie'), qtype: String(record.type ?? 'A'), resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '203.0.113.0/24', country: 'IE', asn: 5466 };
    evaluate(rec, scenario);
  } catch (err) {
    adapterCompatible = false;
    warnings.push(`Adapter could not evaluate the live record: ${err instanceof Error ? err.name : 'error'}.`);
  }

  if (!schema.ok) warnings.push('Live payload failed the runtime record schema.');
  if (unsupportedFilters.length > 0) warnings.push(`Unsupported filter(s): ${unsupportedFilters.join(', ')}.`);

  return {
    schemaCompatible: schema.ok,
    schemaIssues: schema.issues,
    adapterCompatible,
    supportedFilters,
    unsupportedFilters,
    unknownMetadataFields: [...unknownMeta],
    unexpectedFields: unexpected,
    missingExpectedFields: missing,
    fieldTypeMismatches: mismatches,
    unsupportedFeatures,
    answerGroupsPresent: detectAnswerGroups(record),
    feedControlledMetadataPresent: hasFeedControlled(answers),
    ecs: 'use_client_subnet' in record ? { present: true, enabled: record.use_client_subnet === true } : { present: false },
    fixtureComparison: fixtureComparison(raw),
    warnings,
  };
}

function analyseGeneric(raw: unknown, shape: z.ZodType<unknown>): Analysis {
  const schema = validate(shape, raw);
  return {
    schemaCompatible: schema.ok,
    schemaIssues: schema.issues,
    adapterCompatible: schema.ok,
    supportedFilters: [],
    unsupportedFilters: [],
    unknownMetadataFields: [],
    unexpectedFields: [],
    missingExpectedFields: [],
    fieldTypeMismatches: [],
    unsupportedFeatures: [],
    answerGroupsPresent: false,
    feedControlledMetadataPresent: hasFeedControlled(raw),
    ecs: { present: false },
    fixtureComparison: { provisionalFixtureFields: [], liveOnlyFields: [], typeMismatches: [], matches: true },
    warnings: schema.ok ? [] : ['Live payload failed the runtime schema.'],
  };
}

function overallStatus(a: Analysis): OverallStatus {
  const criticalMissing = a.missingExpectedFields.some((f) => CRITICAL_FIELDS.has(f));
  const criticalTypeMismatch = a.fieldTypeMismatches.some((m) => CRITICAL_FIELDS.has(m.path));
  if (!a.schemaCompatible || criticalMissing || criticalTypeMismatch) return 'incompatible';
  if (a.unsupportedFilters.length > 0 || !a.adapterCompatible || a.missingExpectedFields.length > 0 || a.fieldTypeMismatches.length > 0) return 'partial';
  const hasWarnings = a.unknownMetadataFields.length > 0 || a.unexpectedFields.length > 0 || a.feedControlledMetadataPresent || a.answerGroupsPresent || !a.fixtureComparison.matches || a.warnings.length > 0;
  return hasWarnings ? 'compatible_with_warnings' : 'compatible';
}

/** Analyse a live payload for the given endpoint. Returns everything except the transport
 *  metadata (checksums, timestamps, sanitised sample) which the service supplies. */
export function analyse(endpoint: ValidationEndpoint, raw: unknown): Omit<ValidationResult, 'endpoint' | 'resourceKey' | 'zone' | 'domain' | 'recordType' | 'sourceMode' | 'retrievedAt' | 'rawChecksum' | 'structuralChecksum' | 'sanitisedSample' | 'fixtureCandidate'> {
  const a = endpoint === 'record' ? analyseRecord(raw) : analyseGeneric(raw, endpoint === 'zone' ? Ns1ZoneShape : endpoint === 'zones' ? Ns1ZonesListShape : Ns1ActivityShape);
  return { ...a, overallStatus: overallStatus(a) };
}

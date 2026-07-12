import { randomUUID } from 'node:crypto';
import type { NewValidationResult, Queryable, ValidationResultQuery, ValidationResultRecord, ValidationResultRepository } from '../types.js';
import { orUndefined, toDate, toJson } from '../mapping.js';

interface Row {
  id: string;
  ran_at: unknown;
  endpoint: string;
  zone: string | null;
  domain: string | null;
  record_type: string | null;
  source_mode: string;
  retrieved_at: unknown;
  raw_checksum: string | null;
  structural_checksum: string | null;
  overall_status: string;
  schema_compatible: boolean;
  adapter_compatible: boolean;
  supported_filters: unknown;
  unsupported_filters: unknown;
  unknown_fields: unknown;
  missing_fields: unknown;
  type_mismatches: unknown;
  answer_groups_present: boolean;
  feed_controlled_present: boolean;
  ecs: unknown;
  fixture_comparison: unknown;
  warnings: unknown;
  sanitised_sample: unknown;
  correlation_id: string | null;
}

const COLUMNS = `id, ran_at, endpoint, zone, domain, record_type, source_mode, retrieved_at, raw_checksum,
  structural_checksum, overall_status, schema_compatible, adapter_compatible, supported_filters, unsupported_filters,
  unknown_fields, missing_fields, type_mismatches, answer_groups_present, feed_controlled_present, ecs,
  fixture_comparison, warnings, sanitised_sample, correlation_id`;

function mapRow(r: Row): ValidationResultRecord {
  return {
    id: r.id,
    ranAt: toDate(r.ran_at),
    endpoint: r.endpoint,
    zone: orUndefined(r.zone),
    domain: orUndefined(r.domain),
    recordType: orUndefined(r.record_type),
    sourceMode: r.source_mode,
    retrievedAt: r.retrieved_at == null ? undefined : toDate(r.retrieved_at),
    rawChecksum: orUndefined(r.raw_checksum),
    structuralChecksum: orUndefined(r.structural_checksum),
    overallStatus: r.overall_status,
    schemaCompatible: r.schema_compatible,
    adapterCompatible: r.adapter_compatible,
    supportedFilters: toJson(r.supported_filters) ?? [],
    unsupportedFilters: toJson(r.unsupported_filters) ?? [],
    unknownFields: toJson(r.unknown_fields) ?? [],
    missingFields: toJson(r.missing_fields) ?? [],
    typeMismatches: toJson(r.type_mismatches) ?? [],
    answerGroupsPresent: r.answer_groups_present,
    feedControlledPresent: r.feed_controlled_present,
    ecs: toJson(r.ecs) ?? {},
    fixtureComparison: toJson(r.fixture_comparison) ?? {},
    warnings: toJson(r.warnings) ?? [],
    sanitisedSample: r.sanitised_sample == null ? undefined : toJson(r.sanitised_sample),
    correlationId: orUndefined(r.correlation_id),
  };
}

/** Bounded, append-only NS1 validation-result history (newest first). */
export class PostgresValidationResultRepository implements ValidationResultRepository {
  constructor(private readonly db: Queryable) {}

  async create(v: NewValidationResult): Promise<ValidationResultRecord> {
    const id = randomUUID();
    const { rows } = await this.db.query<Row>(
      `INSERT INTO ns1_validation_results
         (id, ran_at, endpoint, zone, domain, record_type, source_mode, retrieved_at, raw_checksum,
          structural_checksum, overall_status, schema_compatible, adapter_compatible, supported_filters, unsupported_filters,
          unknown_fields, missing_fields, type_mismatches, answer_groups_present, feed_controlled_present, ecs,
          fixture_comparison, warnings, sanitised_sample, correlation_id)
       VALUES ($1, COALESCE($2, now()), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,
               $18::jsonb,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,$25)
       RETURNING ${COLUMNS}`,
      [
        id, v.ranAt ?? null, v.endpoint, v.zone ?? null, v.domain ?? null, v.recordType ?? null, v.sourceMode,
        v.retrievedAt ?? null, v.rawChecksum ?? null, v.structuralChecksum ?? null, v.overallStatus,
        v.schemaCompatible, v.adapterCompatible, JSON.stringify(v.supportedFilters ?? []), JSON.stringify(v.unsupportedFilters ?? []),
        JSON.stringify(v.unknownFields ?? []), JSON.stringify(v.missingFields ?? []), JSON.stringify(v.typeMismatches ?? []),
        v.answerGroupsPresent, v.feedControlledPresent, JSON.stringify(v.ecs ?? {}), JSON.stringify(v.fixtureComparison ?? {}),
        JSON.stringify(v.warnings ?? []), v.sanitisedSample === undefined ? null : JSON.stringify(v.sanitisedSample), v.correlationId ?? null,
      ],
    );
    return mapRow(rows[0] as Row);
  }

  async getById(id: string): Promise<ValidationResultRecord | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM ns1_validation_results WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async list(query: ValidationResultQuery = {}): Promise<ValidationResultRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (col: string, v: unknown) => {
      if (v === undefined) return;
      params.push(v);
      where.push(`${col} = $${params.length}`);
    };
    eq('zone', query.zone);
    eq('domain', query.domain);
    eq('record_type', query.recordType);
    eq('endpoint', query.endpoint);
    eq('overall_status', query.overallStatus);
    eq('raw_checksum', query.rawChecksum);
    if (query.since !== undefined) {
      params.push(query.since);
      where.push(`ran_at > $${params.length}`);
    }
    if (query.before !== undefined) {
      params.push(query.before);
      where.push(`ran_at <= $${params.length}`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
    params.push(limit);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM ns1_validation_results ${clause} ORDER BY ran_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => mapRow(r as Row));
  }
}

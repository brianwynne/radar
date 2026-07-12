import { randomUUID } from 'node:crypto';
import type { DnsObservationQuery, DnsObservationRecord, DnsObservationRepository, NewDnsObservation, Queryable } from '../types.js';
import { orUndefined, toDate, toJson } from '../mapping.js';

interface Row {
  id: string;
  observed_at: unknown;
  isp_id: string;
  isp_name: string;
  asn: number | null;
  resolver_ip: string | null;
  zone: string;
  domain: string;
  record_type: string;
  ecs_requested: boolean;
  ecs_prefix: string | null;
  ecs_honoured: boolean | null;
  response_code: string | null;
  observed_answers: unknown;
  predicted_answers: unknown;
  comparison_status: string;
  confidence: string;
  ttl: number | null;
  latency_ms: number | null;
  record_checksum: string | null;
  explanation: string | null;
  warnings: unknown;
  provenance: unknown;
  correlation_id: string | null;
}

const COLUMNS = `id, observed_at, isp_id, isp_name, asn, resolver_ip, zone, domain, record_type,
  ecs_requested, ecs_prefix, ecs_honoured, response_code, observed_answers, predicted_answers,
  comparison_status, confidence, ttl, latency_ms, record_checksum, explanation, warnings, provenance, correlation_id`;

function mapRow(r: Row): DnsObservationRecord {
  return {
    id: r.id,
    observedAt: toDate(r.observed_at),
    ispId: r.isp_id,
    ispName: r.isp_name,
    asn: orUndefined(r.asn),
    resolverIp: orUndefined(r.resolver_ip),
    zone: r.zone,
    domain: r.domain,
    recordType: r.record_type,
    ecsRequested: r.ecs_requested,
    ecsPrefix: orUndefined(r.ecs_prefix),
    ecsHonoured: orUndefined(r.ecs_honoured),
    responseCode: orUndefined(r.response_code),
    observedAnswers: toJson(r.observed_answers) ?? [],
    predictedAnswers: toJson(r.predicted_answers) ?? [],
    comparisonStatus: r.comparison_status,
    confidence: r.confidence,
    ttl: orUndefined(r.ttl),
    latencyMs: orUndefined(r.latency_ms),
    recordChecksum: orUndefined(r.record_checksum),
    explanation: orUndefined(r.explanation),
    warnings: toJson(r.warnings) ?? [],
    provenance: toJson(r.provenance) ?? {},
    correlationId: orUndefined(r.correlation_id),
  };
}

/** Bounded, append-only DNS-observation history (newest first). */
export class PostgresDnsObservationRepository implements DnsObservationRepository {
  constructor(private readonly db: Queryable) {}

  async create(o: NewDnsObservation): Promise<DnsObservationRecord> {
    const id = randomUUID();
    const { rows } = await this.db.query<Row>(
      `INSERT INTO dns_observations
         (id, observed_at, isp_id, isp_name, asn, resolver_ip, zone, domain, record_type,
          ecs_requested, ecs_prefix, ecs_honoured, response_code, observed_answers, predicted_answers,
          comparison_status, confidence, ttl, latency_ms, record_checksum, explanation, warnings, provenance, correlation_id)
       VALUES ($1, COALESCE($2, now()), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24)
       RETURNING ${COLUMNS}`,
      [
        id, o.observedAt ?? null, o.ispId, o.ispName, o.asn ?? null, o.resolverIp ?? null, o.zone, o.domain, o.recordType,
        o.ecsRequested, o.ecsPrefix ?? null, o.ecsHonoured ?? null, o.responseCode ?? null,
        JSON.stringify(o.observedAnswers ?? []), JSON.stringify(o.predictedAnswers ?? []),
        o.comparisonStatus, o.confidence, o.ttl ?? null, o.latencyMs ?? null, o.recordChecksum ?? null,
        o.explanation ?? null, JSON.stringify(o.warnings ?? []), JSON.stringify(o.provenance ?? {}), o.correlationId ?? null,
      ],
    );
    return mapRow(rows[0] as Row);
  }

  async list(query: DnsObservationQuery = {}): Promise<DnsObservationRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (col: string, v: unknown) => {
      if (v === undefined) return;
      params.push(v);
      where.push(`${col} = $${params.length}`);
    };
    eq('isp_id', query.ispId);
    eq('resolver_ip', query.resolverIp);
    eq('zone', query.zone);
    eq('domain', query.domain);
    eq('record_type', query.recordType);
    eq('comparison_status', query.comparisonStatus);
    eq('record_checksum', query.recordChecksum);
    if (query.since !== undefined) {
      params.push(query.since);
      where.push(`observed_at > $${params.length}`);
    }
    if (query.before !== undefined) {
      params.push(query.before);
      where.push(`observed_at <= $${params.length}`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
    params.push(limit);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM dns_observations ${clause} ORDER BY observed_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => mapRow(r as Row));
  }

  async latestPerIsp(): Promise<DnsObservationRecord[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM (
         SELECT DISTINCT ON (isp_id) ${COLUMNS}
         FROM dns_observations ORDER BY isp_id, observed_at DESC
       ) latest ORDER BY observed_at DESC`,
    );
    return rows.map((r) => mapRow(r as Row));
  }
}

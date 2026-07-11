import type { NewSteeringState, Queryable, SteeringState, SteeringStateQuery, SteeringStateRepository } from '../types.js';
import { orUndefined, toDate, toJson } from '../mapping.js';

interface Row {
  isp_id: string;
  resource_key: string;
  isp_name: string;
  asn: number | null;
  fingerprint: string;
  identity_source: string | null;
  country: string | null;
  matched_prefix: string | null;
  preferred_path: string | null;
  eligible_answer_ids: unknown;
  distribution: unknown;
  filter_chain: unknown;
  complete: boolean;
  stopped_at_filter_index: number | null;
  structural_checksum: string | null;
  evaluated_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `isp_id, resource_key, isp_name, asn, fingerprint, identity_source, country,
  matched_prefix, preferred_path, eligible_answer_ids, distribution, filter_chain, complete,
  stopped_at_filter_index, structural_checksum, evaluated_at, updated_at`;

function mapRow(r: Row): SteeringState {
  return {
    ispId: r.isp_id,
    resourceKey: r.resource_key,
    ispName: r.isp_name,
    asn: orUndefined(r.asn),
    fingerprint: r.fingerprint,
    identitySource: orUndefined(r.identity_source),
    country: orUndefined(r.country),
    matchedPrefix: orUndefined(r.matched_prefix),
    preferredPath: orUndefined(r.preferred_path),
    eligibleAnswerIds: toJson<string[]>(r.eligible_answer_ids) ?? [],
    distribution: toJson<SteeringState['distribution']>(r.distribution) ?? [],
    filterChain: toJson<string[]>(r.filter_chain) ?? [],
    complete: r.complete,
    stoppedAtFilterIndex: orUndefined(r.stopped_at_filter_index),
    structuralChecksum: orUndefined(r.structural_checksum),
    evaluatedAt: toDate(r.evaluated_at),
    updatedAt: toDate(r.updated_at),
  };
}

/** Latest steering state per (ISP scenario, record). Upserted on every evaluation. */
export class PostgresSteeringStateRepository implements SteeringStateRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(s: NewSteeringState): Promise<void> {
    await this.db.query(
      `INSERT INTO live_steering_states
         (isp_id, resource_key, isp_name, asn, fingerprint, identity_source, country, matched_prefix,
          preferred_path, eligible_answer_ids, distribution, filter_chain, complete,
          stopped_at_filter_index, structural_checksum, evaluated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16, now())
       ON CONFLICT (isp_id, resource_key) DO UPDATE SET
         isp_name = EXCLUDED.isp_name, asn = EXCLUDED.asn, fingerprint = EXCLUDED.fingerprint,
         identity_source = EXCLUDED.identity_source, country = EXCLUDED.country,
         matched_prefix = EXCLUDED.matched_prefix, preferred_path = EXCLUDED.preferred_path,
         eligible_answer_ids = EXCLUDED.eligible_answer_ids, distribution = EXCLUDED.distribution,
         filter_chain = EXCLUDED.filter_chain, complete = EXCLUDED.complete,
         stopped_at_filter_index = EXCLUDED.stopped_at_filter_index,
         structural_checksum = EXCLUDED.structural_checksum, evaluated_at = EXCLUDED.evaluated_at,
         updated_at = now()`,
      [
        s.ispId, s.resourceKey, s.ispName, s.asn ?? null, s.fingerprint, s.identitySource ?? null, s.country ?? null,
        s.matchedPrefix ?? null, s.preferredPath ?? null, JSON.stringify(s.eligibleAnswerIds), JSON.stringify(s.distribution),
        JSON.stringify(s.filterChain), s.complete, s.stoppedAtFilterIndex ?? null, s.structuralChecksum ?? null, s.evaluatedAt,
      ],
    );
  }

  async get(ispId: string, resourceKey: string): Promise<SteeringState | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM live_steering_states WHERE isp_id = $1 AND resource_key = $2`,
      [ispId, resourceKey],
    );
    return rows.length > 0 ? mapRow(rows[0] as Row) : null;
  }

  async list(query: SteeringStateQuery = {}): Promise<SteeringState[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (col: string, v: unknown) => {
      if (v === undefined) return;
      params.push(v);
      where.push(`${col} = $${params.length}`);
    };
    eq('isp_id', query.ispId);
    eq('asn', query.asn);
    eq('resource_key', query.resourceKey);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM live_steering_states ${clause} ORDER BY updated_at DESC LIMIT 500`,
      params,
    );
    return rows.map((r) => mapRow(r as Row));
  }
}

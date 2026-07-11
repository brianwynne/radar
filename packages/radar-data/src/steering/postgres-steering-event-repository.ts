import { randomUUID } from 'node:crypto';
import type { NewSteeringChangeEvent, Queryable, SteeringChangeEvent, SteeringEventQuery, SteeringEventRepository } from '../types.js';
import { orUndefined, toDate, toJson } from '../mapping.js';

interface Row {
  id: string;
  occurred_at: unknown;
  isp_id: string;
  isp_name: string;
  asn: number | null;
  resource_key: string;
  reason: string;
  previous_fingerprint: string | null;
  current_fingerprint: string;
  previous_state: unknown;
  current_state: unknown;
  previous_checksum: string | null;
  current_checksum: string | null;
  activity: unknown;
}

const COLUMNS = `id, occurred_at, isp_id, isp_name, asn, resource_key, reason, previous_fingerprint,
  current_fingerprint, previous_state, current_state, previous_checksum, current_checksum, activity`;

function mapRow(r: Row): SteeringChangeEvent {
  return {
    id: r.id,
    occurredAt: toDate(r.occurred_at),
    ispId: r.isp_id,
    ispName: r.isp_name,
    asn: orUndefined(r.asn),
    resourceKey: r.resource_key,
    reason: r.reason,
    previousFingerprint: orUndefined(r.previous_fingerprint),
    currentFingerprint: r.current_fingerprint,
    previousState: r.previous_state == null ? undefined : toJson(r.previous_state),
    currentState: toJson(r.current_state),
    previousChecksum: orUndefined(r.previous_checksum),
    currentChecksum: orUndefined(r.current_checksum),
    activity: toJson<Record<string, unknown>>(r.activity) ?? {},
  };
}

/** Persistent, meaningful steering-change events (append-only), newest first. */
export class PostgresSteeringEventRepository implements SteeringEventRepository {
  constructor(private readonly db: Queryable) {}

  async create(e: NewSteeringChangeEvent): Promise<SteeringChangeEvent> {
    const id = randomUUID();
    const { rows } = await this.db.query<Row>(
      `INSERT INTO steering_change_events
         (id, occurred_at, isp_id, isp_name, asn, resource_key, reason, previous_fingerprint,
          current_fingerprint, previous_state, current_state, previous_checksum, current_checksum, activity)
       VALUES ($1, COALESCE($2, now()), $3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb)
       RETURNING ${COLUMNS}`,
      [
        id, e.occurredAt ?? null, e.ispId, e.ispName, e.asn ?? null, e.resourceKey, e.reason,
        e.previousFingerprint ?? null, e.currentFingerprint,
        e.previousState === undefined ? null : JSON.stringify(e.previousState),
        JSON.stringify(e.currentState), e.previousChecksum ?? null, e.currentChecksum ?? null,
        JSON.stringify(e.activity ?? {}),
      ],
    );
    return mapRow(rows[0] as Row);
  }

  async list(query: SteeringEventQuery = {}): Promise<SteeringChangeEvent[]> {
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
    if (query.since !== undefined) {
      params.push(query.since);
      where.push(`occurred_at > $${params.length}`);
    }
    if (query.before !== undefined) {
      params.push(query.before);
      where.push(`occurred_at <= $${params.length}`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
    params.push(limit);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM steering_change_events ${clause} ORDER BY occurred_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => mapRow(r as Row));
  }
}

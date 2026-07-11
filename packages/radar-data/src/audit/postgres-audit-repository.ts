import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditQuery, NewAuditEvent, Queryable } from '../types.js';
import { orUndefined, toDate, toJson, toStringArray } from '../mapping.js';
import type { AuditRepository } from './audit-repository.js';

interface Row {
  id: string;
  occurred_at: unknown;
  actor_subject: string | null;
  actor_roles: unknown;
  authentication_method: string | null;
  action: string;
  resource_type: string | null;
  resource_key: string | null;
  outcome: string;
  correlation_id: string | null;
  details: unknown;
}

const COLUMNS = `id, occurred_at, actor_subject, actor_roles, authentication_method,
  action, resource_type, resource_key, outcome, correlation_id, details`;

function mapRow(r: Row): AuditEvent {
  return {
    id: r.id,
    occurredAt: toDate(r.occurred_at),
    actorSubject: orUndefined(r.actor_subject),
    actorRoles: toStringArray(r.actor_roles),
    authenticationMethod: orUndefined(r.authentication_method),
    action: r.action,
    resourceType: orUndefined(r.resource_type),
    resourceKey: orUndefined(r.resource_key),
    outcome: r.outcome,
    correlationId: orUndefined(r.correlation_id),
    details: toJson<Record<string, unknown>>(r.details) ?? {},
  };
}

/** PostgreSQL-backed audit store. `occurred_at` defaults to the database clock. Callers
 *  MUST redact secrets from `details` before recording (see NewAuditEvent). */
export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: NewAuditEvent): Promise<AuditEvent> {
    const id = randomUUID();
    const { rows } = await this.db.query<Row>(
      `INSERT INTO audit_events
         (id, actor_subject, actor_roles, authentication_method, action, resource_type,
          resource_key, outcome, correlation_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${COLUMNS}`,
      [
        id,
        input.actorSubject ?? null,
        // node-pg serialises a JS string[] to a PostgreSQL text[] literal for this column.
        input.actorRoles ?? [],
        input.authenticationMethod ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceKey ?? null,
        input.outcome,
        input.correlationId ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
    return mapRow(rows[0] as Row);
  }

  async list(query: AuditQuery = {}): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      params.push(value);
      where.push(`${column} = $${params.length}`);
    };
    eq('actor_subject', query.actorSubject);
    eq('action', query.action);
    eq('resource_type', query.resourceType);
    eq('resource_key', query.resourceKey);
    eq('outcome', query.outcome);
    eq('correlation_id', query.correlationId);
    if (query.occurredAfter !== undefined) {
      params.push(query.occurredAfter);
      where.push(`occurred_at >= $${params.length}`);
    }
    if (query.occurredBefore !== undefined) {
      params.push(query.occurredBefore);
      where.push(`occurred_at <= $${params.length}`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
    params.push(limit);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM audit_events ${clause}
       ORDER BY occurred_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => mapRow(r as Row));
  }
}

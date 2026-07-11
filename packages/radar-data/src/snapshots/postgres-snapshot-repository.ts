import { randomUUID } from 'node:crypto';
import type { ConfigurationSnapshot, NewSnapshot, Queryable, SnapshotQuery } from '../types.js';
import { orUndefined, toDate, toJson } from '../mapping.js';
import type { SnapshotRepository } from './snapshot-repository.js';

interface Row {
  id: string;
  source_system: string;
  resource_kind: string;
  resource_key: string;
  source_endpoint: string | null;
  retrieved_at: unknown;
  created_at: unknown;
  created_by_subject: string | null;
  label: string | null;
  raw_payload: unknown;
  canonical_payload: unknown;
  raw_checksum: string;
  structural_checksum: string | null;
  metadata: unknown;
}

const COLUMNS = `id, source_system, resource_kind, resource_key, source_endpoint,
  retrieved_at, created_at, created_by_subject, label, raw_payload, canonical_payload,
  raw_checksum, structural_checksum, metadata`;

function mapRow(r: Row): ConfigurationSnapshot {
  return {
    id: r.id,
    sourceSystem: r.source_system,
    resourceKind: r.resource_kind,
    resourceKey: r.resource_key,
    sourceEndpoint: orUndefined(r.source_endpoint),
    retrievedAt: toDate(r.retrieved_at),
    createdAt: toDate(r.created_at),
    createdBySubject: orUndefined(r.created_by_subject),
    label: orUndefined(r.label),
    rawPayload: toJson(r.raw_payload),
    canonicalPayload: toJson(r.canonical_payload),
    rawChecksum: r.raw_checksum,
    structuralChecksum: orUndefined(r.structural_checksum),
    metadata: toJson<Record<string, unknown>>(r.metadata) ?? {},
  };
}

/** PostgreSQL-backed snapshot store. Accepts any `Queryable` (an app-wide pool, or a
 *  client inside a transaction); the repository never opens its own connections. */
export class PostgresSnapshotRepository implements SnapshotRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: NewSnapshot): Promise<ConfigurationSnapshot> {
    const id = randomUUID();
    const { rows } = await this.db.query<Row>(
      `INSERT INTO configuration_snapshots
         (id, source_system, resource_kind, resource_key, source_endpoint, retrieved_at,
          created_by_subject, label, raw_payload, canonical_payload, raw_checksum,
          structural_checksum, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13::jsonb)
       RETURNING ${COLUMNS}`,
      [
        id,
        input.sourceSystem,
        input.resourceKind,
        input.resourceKey,
        input.sourceEndpoint ?? null,
        input.retrievedAt,
        input.createdBySubject ?? null,
        input.label ?? null,
        JSON.stringify(input.rawPayload ?? null),
        JSON.stringify(input.canonicalPayload ?? null),
        input.rawChecksum,
        input.structuralChecksum ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRow(rows[0] as Row);
  }

  async getById(id: string): Promise<ConfigurationSnapshot | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM configuration_snapshots WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? mapRow(rows[0] as Row) : null;
  }

  async list(query: SnapshotQuery = {}): Promise<ConfigurationSnapshot[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.resourceKind) {
      params.push(query.resourceKind);
      where.push(`resource_kind = $${params.length}`);
    }
    if (query.resourceKey) {
      params.push(query.resourceKey);
      where.push(`resource_key = $${params.length}`);
    }
    if (query.sourceSystem) {
      params.push(query.sourceSystem);
      where.push(`source_system = $${params.length}`);
    }
    if (query.rawChecksum) {
      params.push(query.rawChecksum);
      where.push(`raw_checksum = $${params.length}`);
    }
    if (query.retrievedSince) {
      params.push(query.retrievedSince);
      where.push(`retrieved_at >= $${params.length}`);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
    params.push(limit);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM configuration_snapshots ${clause}
       ORDER BY retrieved_at DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => mapRow(r as Row));
  }
}

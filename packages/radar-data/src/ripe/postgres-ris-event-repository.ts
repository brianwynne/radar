import type {
  NewRisEvent,
  Queryable,
  RisConnectionChange,
  RisEventQuery,
  RisEventRecord,
  RisEventRepository,
} from '../types.js';
import { toDate } from '../mapping.js';

interface EventRow {
  id: string;
  kind: string;
  prefix: string;
  origin_asn: number | string | null;
  peer_asn: number | string | null;
  path: string | null;
  observation_count: number | string;
  first_at: unknown;
  last_at: unknown;
}

interface ConnRow {
  at: unknown;
  state: string;
  detail: string | null;
}

const intOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const pathToText = (path: number[]): string => path.join(' ');
const pathFromText = (t: string | null): number[] =>
  (t ?? '').trim() === '' ? [] : t!.trim().split(/\s+/).map((n) => Number(n)).filter((n) => Number.isFinite(n));

/** Bounded RIS Live BGP-event history. Events are sparse (RTÉ's monitored prefixes only), so no
 *  downsampling is needed — range reads return the raw rows newest-first within the window. */
export class PostgresRisEventRepository implements RisEventRepository {
  constructor(private readonly db: Queryable) {}

  async upsertBatch(events: NewRisEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const params: unknown[] = [];
    const cols = 9;
    const tuples = events.map((e, i) => {
      const b = i * cols;
      params.push(e.id, e.kind, e.prefix, e.originAsn ?? null, e.peerAsn ?? null, pathToText(e.path), e.observationCount, e.firstAt, e.lastAt);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
    });
    const res = await this.db.query(
      `INSERT INTO ris_events (id, kind, prefix, origin_asn, peer_asn, path, observation_count, first_at, last_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (id) DO UPDATE SET
         last_at = EXCLUDED.last_at,
         observation_count = EXCLUDED.observation_count,
         path = EXCLUDED.path,
         origin_asn = EXCLUDED.origin_asn,
         peer_asn = EXCLUDED.peer_asn`,
      params,
    );
    return res.rowCount ?? 0;
  }

  async range(query: RisEventQuery): Promise<RisEventRecord[]> {
    const until = query.until ?? new Date();
    const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 500)));
    const params: unknown[] = [query.since, until];
    let where = 'last_at >= $1 AND last_at <= $2';
    if (query.prefix) { params.push(query.prefix); where += ` AND prefix = $${params.length}`; }
    if (query.kind) { params.push(query.kind); where += ` AND kind = $${params.length}`; }
    params.push(limit);
    const { rows } = await this.db.query<EventRow>(
      `SELECT id, kind, prefix, origin_asn, peer_asn, path, observation_count, first_at, last_at
         FROM ris_events
        WHERE ${where}
        ORDER BY last_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as NewRisEvent['kind'],
      prefix: r.prefix,
      originAsn: intOrNull(r.origin_asn),
      peerAsn: intOrNull(r.peer_asn),
      path: pathFromText(r.path),
      observationCount: Number(r.observation_count) || 0,
      firstAt: toDate(r.first_at),
      lastAt: toDate(r.last_at),
    }));
  }

  async recordConnectionState(change: RisConnectionChange): Promise<void> {
    await this.db.query(
      `INSERT INTO ris_connection_events (at, state, detail) VALUES ($1, $2, $3)
       ON CONFLICT (at) DO NOTHING`,
      [change.at, change.state, change.detail ?? null],
    );
  }

  async connectionChanges(query: { since: Date; until?: Date; limit?: number }): Promise<RisConnectionChange[]> {
    const until = query.until ?? new Date();
    const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 200)));
    const { rows } = await this.db.query<ConnRow>(
      `SELECT at, state, detail FROM ris_connection_events
        WHERE at >= $1 AND at <= $2
        ORDER BY at DESC
        LIMIT $3`,
      [query.since, until, limit],
    );
    return rows.map((r) => ({ at: toDate(r.at), state: r.state, detail: r.detail }));
  }

  async prune(olderThan: Date): Promise<number> {
    const ev = await this.db.query('DELETE FROM ris_events WHERE last_at < $1', [olderThan]);
    const conn = await this.db.query('DELETE FROM ris_connection_events WHERE at < $1', [olderThan]);
    return (ev.rowCount ?? 0) + (conn.rowCount ?? 0);
  }
}

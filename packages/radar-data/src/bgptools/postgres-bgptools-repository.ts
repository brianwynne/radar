// Postgres repositories for the read-only bgp.tools routing-intelligence tables (migration 0006).
// Framework-independent: everything runs through the minimal `Queryable`. The connector's
// connection settings + encrypted token live in the shared connector_settings table, not here.
import { createHash, randomUUID } from 'node:crypto';
import { orUndefined, toDate, toJson } from '../mapping.js';
import type {
  BgpToolsAddressFamily, BgpToolsIncidentQuery, BgpToolsIncidentRecord, BgpToolsIncidentRepository,
  BgpToolsMonitoredPrefixRepository, BgpToolsObservationQuery, BgpToolsObservationRecord,
  BgpToolsObservationRepository, IncidentKind, IncidentSeverity, IncidentSignal, IncidentState,
  MonitoredPrefixRecord, MonitoredPrefixUpsert, NewBgpToolsObservation, ObservedOriginRecord, Queryable,
} from '../types.js';

/** Canonical checksum over the origin set (order-independent), so an unchanged poll is skipped. */
export function originsChecksum(origins: ObservedOriginRecord[]): string {
  const norm = [...origins].map((o) => ({ asn: o.asn, hits: o.hits })).sort((a, b) => a.asn - b.asn);
  return `sha256:${createHash('sha256').update(JSON.stringify(norm), 'utf8').digest('hex')}`;
}

// ---- Monitored prefixes ---------------------------------------------------------------------

interface PrefixRow {
  prefix: string; address_family: string; expected_origin_asn: string | number; description: string | null;
  created_by: string | null; created_at: unknown; updated_at: unknown;
}
const mapPrefix = (r: PrefixRow): MonitoredPrefixRecord => ({
  prefix: r.prefix,
  addressFamily: r.address_family as BgpToolsAddressFamily,
  expectedOriginAsn: Number(r.expected_origin_asn),
  description: orUndefined(r.description),
  createdBy: orUndefined(r.created_by),
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});

export class PostgresBgpToolsMonitoredPrefixRepository implements BgpToolsMonitoredPrefixRepository {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<MonitoredPrefixRecord[]> {
    const { rows } = await this.db.query<PrefixRow>('SELECT * FROM bgptools_monitored_prefixes ORDER BY prefix');
    return rows.map(mapPrefix);
  }

  async upsert(p: MonitoredPrefixUpsert): Promise<MonitoredPrefixRecord> {
    const { rows } = await this.db.query<PrefixRow>(
      `INSERT INTO bgptools_monitored_prefixes (prefix, address_family, expected_origin_asn, description, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prefix) DO UPDATE SET
         address_family = EXCLUDED.address_family,
         expected_origin_asn = EXCLUDED.expected_origin_asn,
         description = EXCLUDED.description,
         updated_at = now()
       RETURNING *`,
      [p.prefix, p.addressFamily, p.expectedOriginAsn, p.description ?? null, p.createdBy ?? null],
    );
    return mapPrefix(rows[0]);
  }

  async remove(prefix: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM bgptools_monitored_prefixes WHERE prefix = $1', [prefix]);
    return (rowCount ?? 0) > 0;
  }
}

// ---- Observations ---------------------------------------------------------------------------

interface ObsRow {
  id: string; prefix: string; address_family: string; origins: unknown; content_checksum: string;
  observed_at: unknown; source: string; created_at: unknown;
}
const mapObs = (r: ObsRow): BgpToolsObservationRecord => ({
  id: r.id,
  prefix: r.prefix,
  addressFamily: r.address_family as BgpToolsAddressFamily,
  origins: (toJson<ObservedOriginRecord[]>(r.origins) ?? []),
  contentChecksum: r.content_checksum,
  observedAt: toDate(r.observed_at),
  source: r.source,
  createdAt: toDate(r.created_at),
});

export class PostgresBgpToolsObservationRepository implements BgpToolsObservationRepository {
  constructor(private readonly db: Queryable) {}

  async record(o: NewBgpToolsObservation): Promise<{ record: BgpToolsObservationRecord; inserted: boolean }> {
    const checksum = o.contentChecksum ?? originsChecksum(o.origins);
    const latest = await this.db.query<ObsRow>(
      'SELECT * FROM bgptools_observations WHERE prefix = $1 ORDER BY observed_at DESC LIMIT 1',
      [o.prefix],
    );
    if (latest.rows[0] && latest.rows[0].content_checksum === checksum) {
      return { record: mapObs(latest.rows[0]), inserted: false }; // unchanged → skip (change-log)
    }
    const { rows } = await this.db.query<ObsRow>(
      `INSERT INTO bgptools_observations (id, prefix, address_family, origins, content_checksum, observed_at, source)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
      [randomUUID(), o.prefix, o.addressFamily, JSON.stringify(o.origins), checksum, o.observedAt, o.source],
    );
    return { record: mapObs(rows[0]), inserted: true };
  }

  async list(query: BgpToolsObservationQuery = {}): Promise<BgpToolsObservationRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.prefix) { params.push(query.prefix); clauses.push(`prefix = $${params.length}`); }
    if (query.since) { params.push(query.since); clauses.push(`observed_at >= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(1000, Math.max(1, query.limit ?? 200));
    params.push(limit);
    const { rows } = await this.db.query<ObsRow>(
      `SELECT * FROM bgptools_observations ${where} ORDER BY observed_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapObs);
  }

  async prune(olderThan: Date): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM bgptools_observations WHERE observed_at < $1', [olderThan]);
    return rowCount ?? 0;
  }
}

// ---- Incidents ------------------------------------------------------------------------------

interface IncidentRow {
  id: string; prefix: string; kind: string; severity: string; state: string;
  first_detected_at: unknown; last_observed_at: unknown; resolved_at: unknown;
  observation_count: number; evidence: unknown; updated_at: unknown;
}
const mapIncident = (r: IncidentRow): BgpToolsIncidentRecord => ({
  id: r.id,
  prefix: r.prefix,
  kind: r.kind as IncidentKind,
  severity: r.severity as IncidentSeverity,
  state: r.state as IncidentState,
  firstDetectedAt: toDate(r.first_detected_at),
  lastObservedAt: toDate(r.last_observed_at),
  resolvedAt: r.resolved_at ? toDate(r.resolved_at) : undefined,
  observationCount: r.observation_count,
  evidence: toJson(r.evidence),
  updatedAt: toDate(r.updated_at),
});

const OPEN_STATES = "('detected','active','acknowledged')";

export class PostgresBgpToolsIncidentRepository implements BgpToolsIncidentRepository {
  constructor(private readonly db: Queryable) {}

  async openOrUpdate(s: IncidentSignal): Promise<BgpToolsIncidentRecord> {
    // Update the existing open incident for (prefix, kind); a 'detected' incident becomes 'active'
    // on its second observation.
    const updated = await this.db.query<IncidentRow>(
      `UPDATE bgptools_incidents
         SET last_observed_at = $3, observation_count = observation_count + 1, severity = $4,
             evidence = $5::jsonb, state = CASE WHEN state = 'detected' THEN 'active' ELSE state END,
             updated_at = now()
       WHERE prefix = $1 AND kind = $2 AND state IN ${OPEN_STATES}
       RETURNING *`,
      [s.prefix, s.kind, s.observedAt, s.severity, JSON.stringify(s.evidence ?? null)],
    );
    if (updated.rows[0]) return mapIncident(updated.rows[0]);

    const { rows } = await this.db.query<IncidentRow>(
      `INSERT INTO bgptools_incidents (id, prefix, kind, severity, state, first_detected_at, last_observed_at, observation_count, evidence)
       VALUES ($1, $2, $3, $4, 'detected', $5, $5, 1, $6::jsonb) RETURNING *`,
      [randomUUID(), s.prefix, s.kind, s.severity, s.observedAt, JSON.stringify(s.evidence ?? null)],
    );
    return mapIncident(rows[0]);
  }

  async resolveOpen(prefix: string, kind: IncidentKind, at: Date): Promise<BgpToolsIncidentRecord | null> {
    const { rows } = await this.db.query<IncidentRow>(
      `UPDATE bgptools_incidents SET state = 'resolved', resolved_at = $3, updated_at = now()
       WHERE prefix = $1 AND kind = $2 AND state IN ${OPEN_STATES} RETURNING *`,
      [prefix, kind, at],
    );
    return rows[0] ? mapIncident(rows[0]) : null;
  }

  async list(query: BgpToolsIncidentQuery = {}): Promise<BgpToolsIncidentRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.prefix) { params.push(query.prefix); clauses.push(`prefix = $${params.length}`); }
    if (query.state) { params.push(query.state); clauses.push(`state = $${params.length}`); }
    if (query.openOnly) clauses.push(`state IN ${OPEN_STATES}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(1000, Math.max(1, query.limit ?? 200));
    params.push(limit);
    const { rows } = await this.db.query<IncidentRow>(
      `SELECT * FROM bgptools_incidents ${where} ORDER BY first_detected_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapIncident);
  }
}

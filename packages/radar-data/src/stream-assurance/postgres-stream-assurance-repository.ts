import type {
  NewStreamAssuranceProfile,
  NewStreamAssuranceRun,
  Queryable,
  StreamAlertRow,
  StreamAssuranceProfileRow,
  StreamAssuranceRepository,
  StreamAssuranceRunRow,
  UpsertStreamAlert,
} from '../types.js';
import { toDate } from '../mapping.js';

// jsonb comes back parsed from node-pg but as a string from pg-mem — coerce defensively.
const asJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

interface ProfileRow { id: string; name: string; config: unknown; enabled: boolean; created_at: unknown; updated_at: unknown }
interface RunRow { id: string; profile_id: string; started_at: unknown; finished_at: unknown; mode: string; status: string; observations: unknown; findings: unknown; finding_count: number | string }
interface AlertRow {
  id: string; profile_id: string; endpoint_id: string; rule_id: string; classification: string; severity: string; state: string;
  consecutive_present: number | string; consecutive_absent: number | string; occurrences: number | string;
  first_observed: unknown; last_observed: unknown; explanation: string | null; remediation: string | null; evidence: unknown;
  acknowledged_by: string | null; acknowledged_at: unknown; updated_at: unknown;
}

/** Persistence for Stream Assurance profiles + bounded run snapshots. */
export class PostgresStreamAssuranceRepository implements StreamAssuranceRepository {
  constructor(private readonly db: Queryable) {}

  async upsertProfile(p: NewStreamAssuranceProfile): Promise<void> {
    await this.db.query(
      `INSERT INTO sa_profiles (id, name, config, enabled, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config, enabled = EXCLUDED.enabled, updated_at = now()`,
      [p.id, p.name, JSON.stringify(p.config), p.enabled ?? true],
    );
  }

  async listProfiles(): Promise<StreamAssuranceProfileRow[]> {
    const { rows } = await this.db.query<ProfileRow>('SELECT id, name, config, enabled, created_at, updated_at FROM sa_profiles ORDER BY name');
    return rows.map(this.mapProfile);
  }

  async getProfile(id: string): Promise<StreamAssuranceProfileRow | null> {
    const { rows } = await this.db.query<ProfileRow>('SELECT id, name, config, enabled, created_at, updated_at FROM sa_profiles WHERE id = $1', [id]);
    return rows[0] ? this.mapProfile(rows[0]) : null;
  }

  async deleteProfile(id: string): Promise<void> {
    await this.db.query('DELETE FROM sa_profiles WHERE id = $1', [id]);
  }

  async insertRun(r: NewStreamAssuranceRun): Promise<void> {
    await this.db.query(
      `INSERT INTO sa_runs (id, profile_id, started_at, finished_at, mode, status, observations, findings, finding_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.profileId, r.startedAt, r.finishedAt, r.mode, r.status, JSON.stringify(r.observations), JSON.stringify(r.findings), r.findingCount],
    );
  }

  async latestRun(profileId: string): Promise<StreamAssuranceRunRow | null> {
    const { rows } = await this.db.query<RunRow>('SELECT * FROM sa_runs WHERE profile_id = $1 ORDER BY started_at DESC LIMIT 1', [profileId]);
    return rows[0] ? this.mapRun(rows[0]) : null;
  }

  async listRuns(profileId: string, limit = 50): Promise<StreamAssuranceRunRow[]> {
    const { rows } = await this.db.query<RunRow>('SELECT * FROM sa_runs WHERE profile_id = $1 ORDER BY started_at DESC LIMIT $2', [profileId, Math.min(200, Math.max(1, limit))]);
    return rows.map(this.mapRun);
  }

  async pruneRuns(olderThan: Date): Promise<number> {
    const res = await this.db.query('DELETE FROM sa_runs WHERE started_at < $1', [olderThan]);
    return res.rowCount ?? 0;
  }

  // --- Alert lifecycle ------------------------------------------------------
  private readonly ALERT_COLS = 'id, profile_id, endpoint_id, rule_id, classification, severity, state, consecutive_present, consecutive_absent, occurrences, first_observed, last_observed, explanation, remediation, evidence, acknowledged_by, acknowledged_at, updated_at';

  async listAlertsByProfile(profileId: string): Promise<StreamAlertRow[]> {
    const { rows } = await this.db.query<AlertRow>(`SELECT ${this.ALERT_COLS} FROM sa_alerts WHERE profile_id = $1 ORDER BY last_observed DESC`, [profileId]);
    return rows.map(this.mapAlert);
  }

  async listOpenAlerts(profileId?: string): Promise<StreamAlertRow[]> {
    const where = profileId ? 'WHERE state <> $2 AND profile_id = $1' : "WHERE state <> 'resolved'";
    const params = profileId ? [profileId, 'resolved'] : [];
    const { rows } = await this.db.query<AlertRow>(`SELECT ${this.ALERT_COLS} FROM sa_alerts ${where} ORDER BY last_observed DESC`, params);
    return rows.map(this.mapAlert);
  }

  async getAlert(id: string): Promise<StreamAlertRow | null> {
    const { rows } = await this.db.query<AlertRow>(`SELECT ${this.ALERT_COLS} FROM sa_alerts WHERE id = $1`, [id]);
    return rows[0] ? this.mapAlert(rows[0]) : null;
  }

  async upsertAlert(a: UpsertStreamAlert): Promise<void> {
    await this.db.query(
      `INSERT INTO sa_alerts (id, profile_id, endpoint_id, rule_id, classification, severity, state, consecutive_present, consecutive_absent, occurrences, first_observed, last_observed, explanation, remediation, evidence, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
       ON CONFLICT (id) DO UPDATE SET
         severity = EXCLUDED.severity, state = EXCLUDED.state,
         consecutive_present = EXCLUDED.consecutive_present, consecutive_absent = EXCLUDED.consecutive_absent,
         occurrences = EXCLUDED.occurrences, last_observed = EXCLUDED.last_observed,
         explanation = EXCLUDED.explanation, remediation = EXCLUDED.remediation, evidence = EXCLUDED.evidence,
         updated_at = EXCLUDED.updated_at`,
      [a.id, a.profileId, a.endpointId, a.ruleId, a.classification, a.severity, a.state, a.consecutivePresent, a.consecutiveAbsent, a.occurrences, a.firstObserved, a.lastObserved, a.explanation, a.remediation, JSON.stringify(a.evidence ?? null), a.updatedAt],
    );
  }

  async acknowledgeAlert(id: string, by: string): Promise<StreamAlertRow | null> {
    await this.db.query("UPDATE sa_alerts SET state = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now() WHERE id = $1 AND state <> 'resolved'", [id, by]);
    return this.getAlert(id);
  }

  async resolveAlert(id: string): Promise<StreamAlertRow | null> {
    await this.db.query("UPDATE sa_alerts SET state = 'resolved', updated_at = now() WHERE id = $1", [id]);
    return this.getAlert(id);
  }

  async pruneAlerts(olderThan: Date): Promise<number> {
    const res = await this.db.query("DELETE FROM sa_alerts WHERE state = 'resolved' AND updated_at < $1", [olderThan]);
    return res.rowCount ?? 0;
  }

  private mapAlert = (r: AlertRow): StreamAlertRow => ({
    id: r.id, profileId: r.profile_id, endpointId: r.endpoint_id, ruleId: r.rule_id, classification: r.classification, severity: r.severity,
    state: r.state, consecutivePresent: Number(r.consecutive_present) || 0, consecutiveAbsent: Number(r.consecutive_absent) || 0, occurrences: Number(r.occurrences) || 0,
    firstObserved: toDate(r.first_observed), lastObserved: toDate(r.last_observed), explanation: r.explanation, remediation: r.remediation, evidence: asJson(r.evidence),
    acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at ? toDate(r.acknowledged_at) : null, updatedAt: toDate(r.updated_at),
  });

  private mapProfile = (r: ProfileRow): StreamAssuranceProfileRow => ({
    id: r.id, name: r.name, config: asJson(r.config), enabled: r.enabled, createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  });

  private mapRun = (r: RunRow): StreamAssuranceRunRow => ({
    id: r.id, profileId: r.profile_id, startedAt: toDate(r.started_at), finishedAt: r.finished_at ? toDate(r.finished_at) : null,
    mode: r.mode, status: r.status, observations: asJson(r.observations), findings: asJson(r.findings), findingCount: Number(r.finding_count) || 0,
  });
}

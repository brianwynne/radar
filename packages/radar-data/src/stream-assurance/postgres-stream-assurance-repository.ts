import type {
  NewStreamAssuranceProfile,
  NewStreamAssuranceRun,
  Queryable,
  StreamAssuranceProfileRow,
  StreamAssuranceRepository,
  StreamAssuranceRunRow,
} from '../types.js';
import { toDate } from '../mapping.js';

// jsonb comes back parsed from node-pg but as a string from pg-mem — coerce defensively.
const asJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

interface ProfileRow { id: string; name: string; config: unknown; enabled: boolean; created_at: unknown; updated_at: unknown }
interface RunRow { id: string; profile_id: string; started_at: unknown; finished_at: unknown; mode: string; status: string; observations: unknown; findings: unknown; finding_count: number | string }

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

  private mapProfile = (r: ProfileRow): StreamAssuranceProfileRow => ({
    id: r.id, name: r.name, config: asJson(r.config), enabled: r.enabled, createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  });

  private mapRun = (r: RunRow): StreamAssuranceRunRow => ({
    id: r.id, profileId: r.profile_id, startedAt: toDate(r.started_at), finishedAt: r.finished_at ? toDate(r.finished_at) : null,
    mode: r.mode, status: r.status, observations: asJson(r.observations), findings: asJson(r.findings), findingCount: Number(r.finding_count) || 0,
  });
}

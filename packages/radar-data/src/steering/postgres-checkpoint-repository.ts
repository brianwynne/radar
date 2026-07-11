import type { CheckpointRecord, CheckpointRepository, Queryable } from '../types.js';
import { orUndefined, toDate } from '../mapping.js';

interface Row {
  source: string;
  checkpoint_id: string | null;
  checkpoint_occurred_at: unknown;
  updated_at: unknown;
}

/** Single-row-per-source change-detection checkpoint (durable, survives restart). */
export class PostgresCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: Queryable) {}

  async get(source: string): Promise<CheckpointRecord | null> {
    const { rows } = await this.db.query<Row>(
      'SELECT source, checkpoint_id, checkpoint_occurred_at, updated_at FROM change_detection_checkpoints WHERE source = $1',
      [source],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Row;
    return {
      source: r.source,
      checkpointId: orUndefined(r.checkpoint_id),
      checkpointOccurredAt: r.checkpoint_occurred_at ? toDate(r.checkpoint_occurred_at) : undefined,
      updatedAt: toDate(r.updated_at),
    };
  }

  async upsert(source: string, checkpointId: string | undefined, checkpointOccurredAt: Date | undefined): Promise<void> {
    await this.db.query(
      `INSERT INTO change_detection_checkpoints (source, checkpoint_id, checkpoint_occurred_at, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (source) DO UPDATE SET
         checkpoint_id = EXCLUDED.checkpoint_id,
         checkpoint_occurred_at = EXCLUDED.checkpoint_occurred_at,
         updated_at = now()`,
      [source, checkpointId ?? null, checkpointOccurredAt ?? null],
    );
  }
}

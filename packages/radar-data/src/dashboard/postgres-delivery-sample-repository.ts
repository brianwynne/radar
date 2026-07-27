import type { DeliveryAverages, DeliverySampleRepository, NewDeliverySample, Queryable } from '../types.js';

// AVG() returns numeric, which node-pg hands back as a string; coerce defensively.
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** Append-only, bounded history of total live delivery throughput (Réalta eyeball + commercial CDNs).
 *  Writes come from a periodic sampler; reads drive the Dashboard pie's 1-hour average. */
export class PostgresDeliverySampleRepository implements DeliverySampleRepository {
  constructor(private readonly db: Queryable) {}

  async insert(sample: NewDeliverySample): Promise<void> {
    await this.db.query(
      `INSERT INTO delivery_samples (observed_at, realta_bps, commercial_bps, total_bps)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (observed_at) DO NOTHING`,
      [sample.at, sample.realtaBps, sample.commercialBps, sample.totalBps],
    );
  }

  async averageSince(since: Date): Promise<DeliveryAverages> {
    const { rows } = await this.db.query<{ ar: unknown; ac: unknown; at: unknown; n: unknown }>(
      `SELECT avg(realta_bps) AS ar, avg(commercial_bps) AS ac, avg(total_bps) AS at, count(*) AS n
         FROM delivery_samples
        WHERE observed_at >= $1`,
      [since],
    );
    const r = rows[0];
    return {
      avgRealtaBps: numOrNull(r?.ar),
      avgCommercialBps: numOrNull(r?.ac),
      avgTotalBps: numOrNull(r?.at),
      sampleCount: Number(r?.n) || 0,
    };
  }

  async prune(olderThan: Date): Promise<number> {
    const res = await this.db.query('DELETE FROM delivery_samples WHERE observed_at < $1', [olderThan]);
    return res.rowCount ?? 0;
  }
}

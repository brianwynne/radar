import type {
  NewPniBandwidthSample,
  PniBandwidthPoint,
  PniBandwidthRangeQuery,
  PniBandwidthRepository,
  Queryable,
} from '../types.js';
import { toDate } from '../mapping.js';

interface Row {
  device_id: string;
  interface_name: string;
  provider: string | null;
  link_type: string | null;
  datacentre: string | null;
  at: unknown;
  in_bps: number | string | null;
  out_bps: number | string | null;
}

// AVG() returns numeric, which node-pg hands back as a string; coerce defensively.
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** Append-only per-PNI bandwidth history. Range reads are downsampled server-side (AVG per
 *  time bucket) so a 24-hour window returns a bounded number of points, not 8640 per series. */
export class PostgresPniBandwidthRepository implements PniBandwidthRepository {
  constructor(private readonly db: Queryable) {}

  async insertBatch(at: Date, samples: NewPniBandwidthSample[]): Promise<number> {
    if (samples.length === 0) return 0;
    const params: unknown[] = [at];
    const cols = 7; // per-row params (observed_at is the shared $1)
    const tuples = samples.map((s, i) => {
      const b = i * cols;
      params.push(s.deviceId, s.interfaceName, s.provider ?? null, s.linkType ?? null, s.datacentre ?? null, s.inBps ?? null, s.outBps ?? null);
      return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
    });
    const res = await this.db.query(
      `INSERT INTO pni_bandwidth_samples (observed_at, device_id, interface_name, provider, link_type, datacentre, in_bps, out_bps)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (device_id, interface_name, observed_at) DO NOTHING`,
      params,
    );
    return res.rowCount ?? 0;
  }

  async range(query: PniBandwidthRangeQuery): Promise<PniBandwidthPoint[]> {
    const bucket = Math.max(1, Math.trunc(query.bucketSeconds));
    const until = query.until ?? new Date();
    const { rows } = await this.db.query<Row>(
      `SELECT device_id, interface_name, max(provider) AS provider,
              max(link_type) AS link_type, max(datacentre) AS datacentre,
              to_timestamp(floor(extract(epoch from observed_at) / $1) * $1) AS at,
              avg(in_bps) AS in_bps, avg(out_bps) AS out_bps
         FROM pni_bandwidth_samples
        WHERE observed_at >= $2 AND observed_at <= $3
        GROUP BY device_id, interface_name,
                 to_timestamp(floor(extract(epoch from observed_at) / $1) * $1)
        ORDER BY device_id, interface_name, at`,
      [bucket, query.since, until],
    );
    return rows.map((r) => ({
      deviceId: r.device_id,
      interfaceName: r.interface_name,
      provider: r.provider,
      linkType: r.link_type,
      datacentre: r.datacentre,
      at: toDate(r.at),
      inBps: numOrNull(r.in_bps),
      outBps: numOrNull(r.out_bps),
    }));
  }

  async prune(olderThan: Date): Promise<number> {
    const res = await this.db.query('DELETE FROM pni_bandwidth_samples WHERE observed_at < $1', [olderThan]);
    return res.rowCount ?? 0;
  }
}

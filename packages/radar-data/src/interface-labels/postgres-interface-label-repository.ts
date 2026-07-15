// Postgres repository for operator-assigned interface friendly names.
import type { InterfaceLabelRecord, InterfaceLabelRepository, Queryable } from '../types.js';
import { toDate } from '../mapping.js';

interface Row {
  device_id: string;
  interface_name: string;
  friendly_name: string;
  updated_by: string | null;
  updated_at: unknown;
}

const map = (r: Row): InterfaceLabelRecord => ({
  deviceId: r.device_id,
  interfaceName: r.interface_name,
  friendlyName: r.friendly_name,
  updatedBy: r.updated_by,
  updatedAt: toDate(r.updated_at),
});

const COLUMNS = 'device_id, interface_name, friendly_name, updated_by, updated_at';

export class PostgresInterfaceLabelRepository implements InterfaceLabelRepository {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<InterfaceLabelRecord[]> {
    const res = await this.db.query<Row>(`SELECT ${COLUMNS} FROM interface_labels`);
    return res.rows.map(map);
  }

  async upsert(deviceId: string, interfaceName: string, friendlyName: string, updatedBy: string | null): Promise<InterfaceLabelRecord> {
    const res = await this.db.query<Row>(
      `INSERT INTO interface_labels (device_id, interface_name, friendly_name, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (device_id, interface_name) DO UPDATE SET friendly_name = EXCLUDED.friendly_name, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${COLUMNS}`,
      [deviceId, interfaceName, friendlyName, updatedBy],
    );
    return map(res.rows[0]);
  }

  async remove(deviceId: string, interfaceName: string): Promise<void> {
    await this.db.query('DELETE FROM interface_labels WHERE device_id = $1 AND interface_name = $2', [deviceId, interfaceName]);
  }
}

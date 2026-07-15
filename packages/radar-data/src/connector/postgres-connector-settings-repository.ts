// Postgres repository for Engineer-managed connector settings. The token is written ONLY as
// opaque AES-256-GCM ciphertext supplied by the caller; this layer never sees plaintext and
// never logs the row. The token action is honoured atomically in the upsert: `retain` never
// touches the token columns, `replace` sets them (with token_set_at = now()), `clear` nulls
// them.
import type {
  ConnectorSettingsRecord,
  ConnectorSettingsRepository,
  ConnectorSettingsUpdate,
  Queryable,
} from '../types.js';
import { toDate } from '../mapping.js';

interface Row {
  connector: string;
  enabled: boolean;
  mode: string;
  endpoint: string | null;
  verify_tls: boolean;
  edge_device_ids: string | null;
  token_ciphertext: Buffer | null;
  token_nonce: Buffer | null;
  token_tag: Buffer | null;
  token_set_at: unknown;
  updated_by: string | null;
  updated_at: unknown;
}

const COLUMNS = `connector, enabled, mode, endpoint, verify_tls, edge_device_ids,
  token_ciphertext, token_nonce, token_tag, token_set_at, updated_by, updated_at`;

function mapRow(r: Row): ConnectorSettingsRecord {
  return {
    connector: r.connector,
    enabled: r.enabled,
    mode: r.mode,
    endpoint: r.endpoint,
    verifyTls: r.verify_tls,
    edgeDeviceIds: r.edge_device_ids,
    tokenCiphertext: r.token_ciphertext ?? null,
    tokenNonce: r.token_nonce ?? null,
    tokenTag: r.token_tag ?? null,
    tokenSetAt: r.token_set_at == null ? null : toDate(r.token_set_at),
    updatedBy: r.updated_by,
    updatedAt: toDate(r.updated_at),
  };
}

export class PostgresConnectorSettingsRepository implements ConnectorSettingsRepository {
  constructor(private readonly db: Queryable) {}

  async get(connector: string): Promise<ConnectorSettingsRecord | null> {
    const res = await this.db.query<Row>(`SELECT ${COLUMNS} FROM connector_settings WHERE connector = $1`, [connector]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async upsert(u: ConnectorSettingsUpdate): Promise<ConnectorSettingsRecord> {
    // The token-column clause of the upsert varies by action. Non-token columns always update.
    const base = 'enabled = EXCLUDED.enabled, mode = EXCLUDED.mode, endpoint = EXCLUDED.endpoint, verify_tls = EXCLUDED.verify_tls, edge_device_ids = EXCLUDED.edge_device_ids, updated_by = EXCLUDED.updated_by, updated_at = now()';
    let tokenSet: string;
    let tokenValues: [Buffer | null, Buffer | null, Buffer | null, Date | null];
    if (u.tokenAction === 'replace') {
      tokenSet = ', token_ciphertext = EXCLUDED.token_ciphertext, token_nonce = EXCLUDED.token_nonce, token_tag = EXCLUDED.token_tag, token_set_at = now()';
      tokenValues = [u.tokenCiphertext ?? null, u.tokenNonce ?? null, u.tokenTag ?? null, new Date()];
    } else if (u.tokenAction === 'clear') {
      tokenSet = ', token_ciphertext = NULL, token_nonce = NULL, token_tag = NULL, token_set_at = NULL';
      tokenValues = [null, null, null, null];
    } else {
      // retain: leave existing token columns untouched on conflict; NULL on first insert.
      tokenSet = '';
      tokenValues = [null, null, null, null];
    }

    const res = await this.db.query<Row>(
      `INSERT INTO connector_settings (connector, enabled, mode, endpoint, verify_tls, edge_device_ids, token_ciphertext, token_nonce, token_tag, token_set_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (connector) DO UPDATE SET ${base}${tokenSet}
       RETURNING ${COLUMNS}`,
      [u.connector, u.enabled, u.mode, u.endpoint, u.verifyTls, u.edgeDeviceIds, tokenValues[0], tokenValues[1], tokenValues[2], tokenValues[3], u.updatedBy],
    );
    return mapRow(res.rows[0]);
  }
}

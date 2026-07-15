// Engineer-managed connector settings store. Composes the @radar/data repository over the
// app-wide pool. The token is only ever handled as encrypted material here.
import type { Pool } from 'pg';
import { PostgresConnectorSettingsRepository, type ConnectorSettingsRepository, type Queryable } from '@radar/data';

export function createConnectorSettingsStore(pool: Pool): ConnectorSettingsRepository {
  return new PostgresConnectorSettingsRepository(pool as unknown as Queryable);
}

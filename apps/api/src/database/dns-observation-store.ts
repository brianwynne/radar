// Persistent bounded history of DNS observations. Composes the @radar/data repository over
// the app-wide pool.
import type { Pool } from 'pg';
import { PostgresDnsObservationRepository, type DnsObservationRepository, type Queryable } from '@radar/data';

export function createDnsObservationStore(pool: Pool): DnsObservationRepository {
  return new PostgresDnsObservationRepository(pool as unknown as Queryable);
}

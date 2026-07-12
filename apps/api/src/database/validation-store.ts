// Persistent bounded history of NS1 validation results. Composes the @radar/data repository
// over the app-wide pool.
import type { Pool } from 'pg';
import { PostgresValidationResultRepository, type Queryable, type ValidationResultRepository } from '@radar/data';

export function createValidationStore(pool: Pool): ValidationResultRepository {
  return new PostgresValidationResultRepository(pool as unknown as Queryable);
}

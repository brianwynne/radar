// Operator interface friendly-name store. Composes the @radar/data repository over the pool.
import type { Pool } from 'pg';
import { PostgresInterfaceLabelRepository, type InterfaceLabelRepository, type Queryable } from '@radar/data';

export function createInterfaceLabelStore(pool: Pool): InterfaceLabelRepository {
  return new PostgresInterfaceLabelRepository(pool as unknown as Queryable);
}

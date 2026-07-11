import type { ConfigurationSnapshot, NewSnapshot, SnapshotQuery } from '../types.js';

/** Framework-independent persistence contract for configuration snapshots. Consumers
 *  depend on this interface, never on a concrete PostgreSQL implementation. */
export interface SnapshotRepository {
  create(input: NewSnapshot): Promise<ConfigurationSnapshot>;
  getById(id: string): Promise<ConfigurationSnapshot | null>;
  list(query?: SnapshotQuery): Promise<ConfigurationSnapshot[]>;
}

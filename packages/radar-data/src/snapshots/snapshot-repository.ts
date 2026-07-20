import type { ConfigurationSnapshot, NewSnapshot, SnapshotQuery } from '../types.js';

/** Framework-independent persistence contract for configuration snapshots. Consumers
 *  depend on this interface, never on a concrete PostgreSQL implementation. */
export interface SnapshotRepository {
  create(input: NewSnapshot): Promise<ConfigurationSnapshot>;
  getById(id: string): Promise<ConfigurationSnapshot | null>;
  list(query?: SnapshotQuery): Promise<ConfigurationSnapshot[]>;
  /** Rename a snapshot's human label. Only mutates the label (the captured payload,
   *  checksums and provenance are immutable). Returns null when the id is unknown.
   *  A null/blank label clears it. */
  updateLabel(id: string, label: string | null): Promise<ConfigurationSnapshot | null>;
  /** Permanently delete a snapshot. Returns the deleted row (for auditing) or null if unknown. */
  delete(id: string): Promise<ConfigurationSnapshot | null>;
}

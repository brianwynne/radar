// @radar/data — RADAR's framework-independent persistence boundary.
export type {
  Queryable,
  QueryResultLike,
  NewSnapshot,
  ConfigurationSnapshot,
  SnapshotQuery,
  NewAuditEvent,
  AuditEvent,
  AuditQuery,
  CheckpointRecord,
  CheckpointRepository,
  SteeringDistributionShare,
  SteeringState,
  NewSteeringState,
  SteeringStateQuery,
  SteeringStateRepository,
  SteeringChangeEvent,
  NewSteeringChangeEvent,
  SteeringEventQuery,
  SteeringEventRepository,
  DnsObservationRecord,
  NewDnsObservation,
  DnsObservationQuery,
  DnsObservationRepository,
} from './types.js';

export type { SnapshotRepository } from './snapshots/snapshot-repository.js';
export { PostgresSnapshotRepository } from './snapshots/postgres-snapshot-repository.js';

export type { AuditRepository } from './audit/audit-repository.js';
export { PostgresAuditRepository } from './audit/postgres-audit-repository.js';

export { PostgresCheckpointRepository } from './steering/postgres-checkpoint-repository.js';
export { PostgresSteeringStateRepository } from './steering/postgres-steering-state-repository.js';
export { PostgresSteeringEventRepository } from './steering/postgres-steering-event-repository.js';
export { PostgresDnsObservationRepository } from './dns/postgres-dns-observation-repository.js';

export {
  applyMigrations,
  loadMigrations,
  migrationsDir,
  migrationStatus,
  migrationChecksum,
  MigrationChecksumError,
  type MigrationFile,
  type MigrationStatus,
} from './migrations.js';

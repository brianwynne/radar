// Persistent store for change-detection checkpoint, latest per-ISP steering state and
// steering-change events. Composes the @radar/data repositories over the app-wide pool.
import type { Pool } from 'pg';
import {
  PostgresCheckpointRepository,
  PostgresSteeringEventRepository,
  PostgresSteeringStateRepository,
  type CheckpointRepository,
  type Queryable,
  type SteeringEventRepository,
  type SteeringStateRepository,
} from '@radar/data';

export interface SteeringStore {
  checkpoints: CheckpointRepository;
  states: SteeringStateRepository;
  events: SteeringEventRepository;
}

export function createSteeringStore(pool: Pool): SteeringStore {
  const q = pool as unknown as Queryable;
  return {
    checkpoints: new PostgresCheckpointRepository(q),
    states: new PostgresSteeringStateRepository(q),
    events: new PostgresSteeringEventRepository(q),
  };
}

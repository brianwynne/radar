// Change Detection module. The event source is behind ChangeEventSource so the NS1
// Activity-API poller can later be replaced by native NS1 webhooks without touching the
// detection/processing logic.
import type { Ns1ReadClient } from '../ns1/client.js';
import type { RadarMode } from '../ns1/config.js';
import type { Database } from '../database/repositories.js';
import { ChangeDetectionService, type Logger } from './service.js';
import { Ns1ActivityEventSource } from './ns1-event-source.js';

export type {
  ChangeEventSource,
  Checkpoint,
  ActivityBatch,
  WatchedRecord,
  IspScenario,
  SteeringChangedEvent,
  SteeringChangedListener,
  ChangeDetectionStatus,
} from './types.js';
export { ChangeDetectionService, isRelevantActivity } from './service.js';
export { Ns1ActivityEventSource } from './ns1-event-source.js';
export { ISP_SCENARIOS, DEFAULT_WATCHED_RECORDS } from './isps.js';

export interface CreateChangeDetectionOptions {
  client: Ns1ReadClient;
  database: Database;
  mode: RadarMode;
  intervalMs?: number;
  logger?: Logger;
}

export function createChangeDetectionService(opts: CreateChangeDetectionOptions): ChangeDetectionService {
  return new ChangeDetectionService({
    source: new Ns1ActivityEventSource(opts.client),
    client: opts.client,
    database: opts.database,
    mode: opts.mode,
    intervalMs: opts.intervalMs,
    logger: opts.logger,
  });
}

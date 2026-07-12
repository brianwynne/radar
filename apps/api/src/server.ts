// radar-api entry point: load configuration, open the database pool, build the app,
// listen, and shut down gracefully. Stateless — all durable state lives in PostgreSQL.
// Migrations are NOT run here; they are applied by the one-shot migrate command.
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { redactDatabaseUrl } from './database/config.js';
import { createPool } from './database/pool.js';
import { databaseHealthCheck } from './database/health.js';
import { createDatabase } from './database/repositories.js';
import { createSteeringStore } from './database/steering-store.js';
import { PostgresPollerLock } from './database/poller-lock.js';
import { createNs1Client } from './ns1/index.js';
import { createChangeDetectionService } from './change-detection/index.js';
import { createTelemetryClient } from './telemetry/index.js';
import { createCacheTelemetryClient } from './telemetry/cache-index.js';
import { createDnsObservationService } from './dns-observation/index.js';
import { createDnsObservationStore } from './database/dns-observation-store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.database) {
    throw new Error('Refusing to start: DATABASE_URL is required for radar-api.');
  }

  const pool = createPool(config.database);
  const database = createDatabase(pool);
  const steeringStore = createSteeringStore(pool);
  const ns1Client = createNs1Client(config.ns1);
  const changeDetection = config.changeDetection.enabled
    ? createChangeDetectionService({
        client: ns1Client,
        database,
        mode: config.ns1.mode,
        steeringStore,
        lock: new PostgresPollerLock(pool),
        intervalMs: config.changeDetection.intervalMs,
      })
    : undefined;

  const telemetryClient = createTelemetryClient(config.telemetry);
  const cacheTelemetryClient = createCacheTelemetryClient(config.cacheTelemetry);
  const dnsObservationRepository = createDnsObservationStore(pool);
  const dnsObservationService = createDnsObservationService({
    ns1Client,
    config: config.dnsObservation,
    repository: dnsObservationRepository,
    logger: undefined,
  });

  const app = await buildApp(config, {
    databaseHealth: databaseHealthCheck(pool),
    database,
    steeringStore,
    ns1Client,
    changeDetection,
    telemetryClient,
    telemetryMode: config.telemetry.mode,
    cacheTelemetryClient,
    cacheTelemetryMode: config.cacheTelemetry.mode,
    dnsObservationService,
    dnsObservationRepository,
    dnsObservationStaleAfterSeconds: config.dnsObservation.staleAfterSeconds,
  });
  app.log.info(
    { database: redactDatabaseUrl(config.database.url), poolMax: config.database.poolMax },
    'database pool configured',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'radar-api shutting down');
    await changeDetection?.stop();
    dnsObservationService.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(sig));
  }

  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    if (changeDetection) {
      changeDetection.start();
      app.log.info({ intervalMs: config.changeDetection.intervalMs }, 'change detection started');
    }
    if (config.dnsObservation.periodic.enabled) {
      dnsObservationService.start();
      app.log.info({ intervalSeconds: config.dnsObservation.periodic.minIntervalSeconds }, 'periodic DNS observation started');
    }
  } catch (err) {
    app.log.error(err, 'radar-api failed to start');
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

void main();

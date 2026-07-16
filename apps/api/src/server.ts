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
import { createValidationService } from './validation/index.js';
import { createValidationStore } from './database/validation-store.js';
import { CloudVisionConnectorManager } from './cloudvision/manager.js';
import { createCloudflareClient, CloudflarePoller } from './cloudflare/index.js';
import { createConnectorSettingsStore } from './database/connector-settings-store.js';
import { SecretBox } from './security/secret-box.js';

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
  const validationRepository = createValidationStore(pool);
  const validationService = createValidationService({ client: ns1Client, mode: config.ns1.mode, config: config.validation, repository: validationRepository });

  // CloudVision network telemetry: read-only connector managed by the connector manager.
  // Non-secret settings come from Postgres (Engineer-managed) when present, else the env base
  // config; the service-account token is stored encrypted, its master key sourced only from
  // /run/secrets/radar_master_key. The manager owns the poller and reconfigures it at runtime.
  const cloudVisionManager = new CloudVisionConnectorManager({
    baseConfig: config.cloudVision,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
    isDevelopment: config.NODE_ENV === 'development',
  });
  await cloudVisionManager.init();
  const cloudVisionPoller = cloudVisionManager.getPoller();

  // Cloudflare Load Balancing: read-only connector (origin-pool selection downstream of NS1).
  // Token sourced only from /run/secrets/cloudflare_api_token (or env); never persisted here.
  const cloudflarePoller = new CloudflarePoller({
    client: createCloudflareClient(config.cloudflare),
    enabled: config.cloudflare.enabled,
    intervalMs: config.cloudflare.pollIntervalSeconds * 1000,
    maxSampleAgeSeconds: config.cloudflare.maxSampleAgeSeconds,
  });
  cloudflarePoller.start();

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
    validationService,
    validationRepository,
    cloudVisionPoller,
    cloudVisionMode: cloudVisionPoller.status().source,
    cloudVisionManager,
    cloudflarePoller,
  });
  app.log.info(
    { database: redactDatabaseUrl(config.database.url), poolMax: config.database.poolMax },
    'database pool configured',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'radar-api shutting down');
    await changeDetection?.stop();
    dnsObservationService.stop();
    cloudVisionManager.stop();
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
    cloudVisionManager.start(); // self-guards: only polls when the effective config is enabled
    app.log.info({ mode: cloudVisionPoller.status().source, intervalSeconds: config.cloudVision.pollIntervalSeconds }, 'cloudvision connector manager started');
  } catch (err) {
    app.log.error(err, 'radar-api failed to start');
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

void main();

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
import { Ns1ConnectorManager } from './ns1/manager.js';
import { createChangeDetectionService } from './change-detection/index.js';
import { createTelemetryClient } from './telemetry/index.js';
import { createCacheTelemetryClient } from './telemetry/cache-index.js';
import { createDnsObservationService } from './dns-observation/index.js';
import { createDnsObservationStore } from './database/dns-observation-store.js';
import { createValidationService } from './validation/index.js';
import { createValidationStore } from './database/validation-store.js';
import { CloudVisionConnectorManager } from './cloudvision/manager.js';
import { CloudflareConnectorManager } from './cloudflare/manager.js';
import { FastlyConnectorManager } from './fastly/manager.js';
import { AkamaiConnectorManager } from './akamai/manager.js';
import { BgpToolsConnectorManager } from './bgptools/manager.js';
import { RipeService } from './ripe/service.js';
import { PostgresBgpToolsObservationRepository, PostgresBgpToolsIncidentRepository, PostgresBgpToolsMonitoredPrefixRepository, PostgresPniBandwidthRepository, PostgresRisEventRepository, PostgresDeliverySampleRepository, PostgresStreamAssuranceRepository } from '@radar/data';
import { PniBandwidthRecorder } from './cloudvision/pni-recorder.js';
import { TouchstreamConnectorManager } from './touchstream/manager.js';
import { RisEventRecorder } from './ripe/ris-event-recorder.js';
import { DeliveryRecorder } from './dashboard/delivery-recorder.js';
import { StreamAssuranceService } from './stream-assurance/service.js';
import { StreamAssuranceScheduler } from './stream-assurance/scheduler.js';
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
  // NS1 (the core steering source): managed by the connector manager so an Engineer can set the
  // read-only NS1 key + mode on the Integrations page. The manager owns a stable, reconfigurable
  // client that the whole engine holds; the key is stored encrypted (master key from
  // /run/secrets/radar_master_key), else the env NS1_API_KEY / RADAR_MODE base config drives it.
  const ns1Manager = new Ns1ConnectorManager({
    baseConfig: config.ns1,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
  });
  await ns1Manager.init();
  const ns1Client = ns1Manager.getClient();
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
  // Per-PNI bandwidth history: written by the poller (via onSnapshot), read by /network/pni-history.
  const pniBandwidthRepository = new PostgresPniBandwidthRepository(pool);
  const pniBandwidthRecorder = new PniBandwidthRecorder(pniBandwidthRepository, {
    retentionHours: Number(process.env.PNI_RETENTION_HOURS) || undefined, // default (a week) unless overridden
    logger: undefined,
  });
  const cloudVisionManager = new CloudVisionConnectorManager({
    baseConfig: config.cloudVision,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
    isDevelopment: config.NODE_ENV === 'development',
    onSnapshot: (snapshot) => pniBandwidthRecorder.record(snapshot),
  });
  await cloudVisionManager.init();
  const cloudVisionPoller = cloudVisionManager.getPoller();

  // Touchstream delivery monitoring: read-only, disabled by default. Credentials are Engineer-managed
  // via the Integrations page and stored encrypted (both halves in one ciphertext — see manager.ts);
  // the env vars remain a fallback for a fresh box. The manager owns the poller.
  const touchstreamManager = new TouchstreamConnectorManager({
    baseConfig: config.touchstream,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
  });
  await touchstreamManager.init();
  const touchstreamPoller = touchstreamManager.getPoller();

  // bgp.tools external routing intelligence: read-only connector. Non-secret settings come from
  // Postgres (Engineer-managed) when present, else the env base config; the Prometheus monitoring
  // URL (whose UUID is the credential) is stored encrypted, its master key sourced only from
  // /run/secrets/radar_master_key. The manager owns the poller.
  const bgpToolsIncidents = new PostgresBgpToolsIncidentRepository(pool);
  const bgpToolsMonitored = new PostgresBgpToolsMonitoredPrefixRepository(pool);
  const bgpToolsManager = new BgpToolsConnectorManager({
    baseConfig: config.bgpTools,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    observations: new PostgresBgpToolsObservationRepository(pool),
    incidents: bgpToolsIncidents,
    loadMonitoredPrefixes: () => bgpToolsMonitored.list(),
    audit: database.audit,
  });
  await bgpToolsManager.init();

  // RIPE BGP intelligence: read-only public RIPEstat polling + one managed RIS Live connection.
  // No secrets. Self-guards: only polls/connects when enabled.
  const ripeService = new RipeService({ config: config.ripe });
  // Persist RIS Live BGP events (bounded history, default 90 days) so the BGP Intelligence timeline
  // can look back over a retention window, not only the in-memory last-N. Started only when RIPE is on.
  const risEventRepository = new PostgresRisEventRepository(pool);
  const risEventRecorder = new RisEventRecorder(risEventRepository, {
    getEvents: () => ripeService.events(),
    getState: () => ripeService.sourceHealth().risLiveState,
    retentionDays: Number(process.env.RIS_EVENT_RETENTION_DAYS) || undefined, // default 90 days
    logger: undefined,
  });

  // Cloudflare Load Balancing: read-only connector managed by the connector manager. Non-secret
  // settings (account id, zones, mode) come from Postgres when an Engineer has set them, else the
  // env base config; the API token is stored encrypted, its master key sourced only from
  // /run/secrets/radar_master_key. The manager owns the poller and reconfigures it at runtime.
  const cloudflareManager = new CloudflareConnectorManager({
    baseConfig: config.cloudflare,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
    isDevelopment: config.NODE_ENV === 'development',
  });
  await cloudflareManager.init();
  const cloudflarePoller = cloudflareManager.getPoller();

  // Fastly CDN observability: read-only connector managed by the connector manager. Non-secret
  // settings (API base, service ids, mode) come from Postgres when an Engineer has set them, else
  // the env base config; the API token (`global:read`) is stored encrypted, its master key sourced
  // only from /run/secrets/radar_master_key. The manager owns the poller and reconfigures it at runtime.
  const fastlyManager = new FastlyConnectorManager({
    baseConfig: config.fastly,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
    isDevelopment: config.NODE_ENV === 'development',
  });
  await fastlyManager.init();
  const fastlyPoller = fastlyManager.getPoller();
  const fastlyRealtimeStreamer = fastlyManager.getStreamer();

  // Akamai CDN observability: read-only connector aggregating DataStream 2 edge logs pulled from S3
  // (or pushed to the shared-secret ingest route) into per-CP-code per-second telemetry. Managed by
  // the connector manager: non-secret S3 settings + CP codes persist in Postgres (Engineer-managed),
  // the S3 secret key is stored encrypted with the master key from /run/secrets/radar_master_key.
  const akamaiManager = new AkamaiConnectorManager({
    baseConfig: config.akamai,
    repository: createConnectorSettingsStore(pool),
    secretBox: SecretBox.fromMasterKey(),
    audit: database.audit,
  });
  await akamaiManager.init();
  const akamaiConnector = akamaiManager.getConnector();

  // Dashboard delivery pie: sample total live delivery (Réalta eyeball + commercial CDNs) into a
  // bounded history so the pie can show a 1-hour average beside the live total.
  const deliverySampleRepository = new PostgresDeliverySampleRepository(pool);
  const deliveryRecorder = new DeliveryRecorder(deliverySampleRepository, {
    getNetwork: () => cloudVisionPoller.getLatest(),
    getFastly: () => fastlyPoller.latestSnapshot(),
    getAkamai: () => akamaiConnector.snapshot(),
  });

  // Stream Assurance: profile persistence + the SSRF-guarded probe/classify service. SSRF policy is
  // secure by default — managed-internal (on-net/loopback) targets are only reachable when explicitly
  // enabled, and an optional host allowlist further narrows it.
  const streamAssuranceRepository = new PostgresStreamAssuranceRepository(pool);
  const streamAssuranceService = new StreamAssuranceService(streamAssuranceRepository, {
    allowManagedInternal: process.env.SA_ALLOW_MANAGED_INTERNAL === 'true',
    allowHosts: (process.env.SA_ALLOW_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean) || undefined,
  });
  const streamAssuranceScheduler = new StreamAssuranceScheduler(streamAssuranceRepository, streamAssuranceService, {
    normalIntervalMs: Number(process.env.SA_NORMAL_INTERVAL_MS) || undefined,
  });

  const app = await buildApp(config, {
    databaseHealth: databaseHealthCheck(pool),
    database,
    steeringStore,
    ns1Client,
    ns1Manager,
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
    touchstreamPoller,
    touchstreamManager,
    touchstreamEnvironment: config.touchstream.environment,
    pniBandwidthRepository,
    cloudVisionManager,
    cloudflarePoller,
    cloudflareManager,
    fastlyPoller,
    fastlyRealtimeStreamer,
    fastlyManager,
    akamaiConnector,
    akamaiManager,
    bgpToolsManager,
    bgpToolsIncidents,
    bgpToolsMonitored,
    ripeService,
    risEventRepository,
    deliverySampleRepository,
    streamAssuranceRepository,
    streamAssuranceService,
    streamAssuranceScheduler,
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
    touchstreamManager.stop();
    cloudflareManager.stop();
    fastlyManager.stop();
    akamaiManager.stop();
    bgpToolsManager.stop();
    risEventRecorder.stop();
    deliveryRecorder.stop();
    streamAssuranceScheduler.stop();
    ripeService.stop();
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
    touchstreamManager.start(); // self-guards: start() is a no-op when the connector is disabled
    cloudflareManager.start();
    fastlyManager.start(); // self-guards: only polls when the effective config is enabled
    akamaiManager.start(); // self-guards: only polls S3 when enabled with credentials
    bgpToolsManager.start(); // self-guards: only polls when the effective config is enabled
    ripeService.start(); // self-guards: only polls RIPEstat + connects RIS Live when enabled
    if (config.ripe.enabled) risEventRecorder.start(); // drain the RIS buffer to bounded history
    deliveryRecorder.start(); // sample total delivery for the Dashboard pie's 1-hour average
    if (process.env.SA_SCHEDULER_ENABLED === 'true') streamAssuranceScheduler.start(); // periodic stream-assurance runs (event mode is API-triggered regardless)
    app.log.info({ mode: cloudVisionPoller.status().source, intervalSeconds: config.cloudVision.pollIntervalSeconds }, 'cloudvision connector manager started');
  } catch (err) {
    app.log.error(err, 'radar-api failed to start');
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

void main();

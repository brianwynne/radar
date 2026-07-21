// radar-api application factory. Builds a configured Fastify instance with structured
// logging, correlation IDs, secure headers, request-size limits, OpenAPI, and the
// read-only NS1 + DNS-explanation routes. Holds no durable state.
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { ns1Routes } from './routes/ns1.js';
import { ns1AsnRoutes } from './routes/ns1-asn.js';
import { ns1ActiveRoutes } from './routes/ns1-active.js';
import { ns1ConnectionRoutes } from './routes/ns1-connection.js';
import type { Ns1ConnectorManager } from './ns1/manager.js';
import { dnsRoutes } from './routes/dns.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { auditRoutes } from './routes/audit.js';
import { changeDetectionRoutes } from './routes/change-detection.js';
import { liveSteeringRoutes } from './routes/live-steering.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { cacheTelemetryRoutes } from './routes/telemetry-cache.js';
import { dnsObservationRoutes } from './routes/dns-observation.js';
import { validationRoutes } from './routes/validation.js';
import { cloudVisionRoutes } from './routes/cloudvision.js';
import { cloudflareRoutes } from './routes/cloudflare.js';
import { cloudflareConnectionRoutes } from './routes/cloudflare-connection.js';
import { fastlyRoutes } from './routes/fastly.js';
import { fastlyConnectionRoutes } from './routes/fastly-connection.js';
import { resolverRoutes } from './routes/resolvers.js';
import { createAtlasManager, loadAtlasConfig, type ResolverManager } from './atlas/index.js';
import { akamaiRoutes } from './routes/akamai.js';
import { akamaiConnectionRoutes } from './routes/akamai-connection.js';
import type { AkamaiConnector } from './akamai/index.js';
import type { AkamaiConnectorManager } from './akamai/manager.js';
import type { FastlyPoller } from './fastly/poller.js';
import type { FastlyRealtimeStreamer } from './fastly/realtime-streamer.js';
import type { FastlyConnectorManager } from './fastly/manager.js';
import type { CloudflarePoller } from './cloudflare/poller.js';
import type { CloudflareConnectorManager } from './cloudflare/manager.js';
import { cloudVisionConnectionRoutes } from './routes/cloudvision-connection.js';
import type { CloudVisionConnectorManager } from './cloudvision/manager.js';
import { registerAuth, type AuthDeps } from './auth/plugin.js';
import { createOidcVerifier, resolveJwks } from './auth/oidc.js';
import type { DatabaseHealthCheck } from './database/health.js';
import type { Database } from './database/repositories.js';
import type { SteeringStore } from './database/steering-store.js';
import type { ChangeDetectionService } from './change-detection/index.js';
import type { NetworkPathTelemetryClient } from './telemetry/types.js';
import type { TelemetryMode } from './telemetry/index.js';
import type { CacheTelemetryClient } from './telemetry/cache-types.js';
import type { DnsObservationService } from './dns-observation/index.js';
import type { DnsObservationRepository, ValidationResultRepository } from '@radar/data';
import type { ValidationService } from './validation/index.js';
import type { CloudVisionPoller } from './cloudvision/poller.js';
import type { CloudVisionSource } from './cloudvision/types.js';
import { createNs1Client } from './ns1/index.js';
import { ns1WriteRoutes } from './routes/ns1-write.js';
import { createNs1RecordWriter, type Ns1RecordWriter } from './ns1/record-writer.js';
import type { Ns1ReadClient } from './ns1/index.js';
import type { AsnResolver } from './ns1/asn-resolver.js';
import type { CnameResolver } from './ns1/active-record.js';

const CORRELATION_HEADER = 'x-correlation-id';

/** Injectable dependencies for the app factory. Everything is optional so tests can wire
 *  fakes (a local JWKS, a stub database probe, a fixture NS1 client) without external
 *  services. */
export interface BuildDeps extends AuthDeps {
  databaseHealth?: DatabaseHealthCheck;
  ns1Client?: Ns1ReadClient;
  ns1Manager?: Ns1ConnectorManager;
  ns1RecordWriter?: Ns1RecordWriter;
  asnResolver?: AsnResolver;
  ns1ActiveResolveCname?: CnameResolver; // injectable CNAME resolver for the active-record route (tests)
  database?: Database;
  steeringStore?: SteeringStore;
  changeDetection?: ChangeDetectionService;
  telemetryClient?: NetworkPathTelemetryClient;
  telemetryMode?: TelemetryMode;
  cacheTelemetryClient?: CacheTelemetryClient;
  cacheTelemetryMode?: TelemetryMode;
  dnsObservationService?: DnsObservationService;
  dnsObservationRepository?: DnsObservationRepository;
  dnsObservationStaleAfterSeconds?: number;
  validationService?: ValidationService;
  validationRepository?: ValidationResultRepository;
  cloudVisionPoller?: CloudVisionPoller;
  cloudVisionMode?: CloudVisionSource;
  cloudflarePoller?: CloudflarePoller;
  cloudflareManager?: CloudflareConnectorManager;
  cloudVisionManager?: CloudVisionConnectorManager;
  fastlyPoller?: FastlyPoller;
  fastlyRealtimeStreamer?: FastlyRealtimeStreamer;
  fastlyManager?: FastlyConnectorManager;
  akamaiConnector?: AkamaiConnector;
  akamaiManager?: AkamaiConnectorManager;
  atlasManager?: ResolverManager;
}

export async function buildApp(config: Config, deps: BuildDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: config.MAX_BODY_BYTES,
    trustProxy: true,
    // Reuse a supplied correlation id, else generate one. This becomes req.id, is
    // attached to every log line, and is echoed on every response.
    genReqId(req) {
      const h = req.headers[CORRELATION_HEADER];
      const supplied = Array.isArray(h) ? h[0] : h;
      return supplied && supplied.length > 0 && supplied.length <= 200 ? supplied : randomUUID();
    },
    logger: {
      level: config.LOG_LEVEL,
      // Never log secrets or credentials.
      redact: ['req.headers.authorization', 'req.headers["x-nsone-key"]', 'req.headers.cookie'],
    },
  });

  // Reject oversized requests early (defence-in-depth alongside Fastify's bodyLimit,
  // which covers chunked bodies with no Content-Length).
  app.addHook('onRequest', async (req, reply) => {
    // The DataStream 2 ingest endpoint is a data-plane sink for large log batches; it is governed by
    // its own (higher) per-route bodyLimit, so it is exempt from the small global request-size guard.
    if (req.url.startsWith('/api/v1/cdn/akamai/datastream/ingest')) return;
    const len = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(len) && len > config.MAX_BODY_BYTES) {
      await reply.code(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured limit.',
        correlationId: req.id,
      });
    }
  });

  // Echo the correlation id on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header(CORRELATION_HEADER, req.id);
  });

  // Authentication: attaches request.principal per the configured mode. In OIDC mode,
  // resolve the JWKS key source (discovery or explicit override) unless a verifier was
  // injected (tests inject a local key set so Microsoft is never contacted).
  let authDeps = deps;
  if (config.authMode === 'oidc' && !deps.oidcVerifier && config.oidc) {
    const getKey = await resolveJwks(config.oidc);
    authDeps = { ...deps, oidcVerifier: createOidcVerifier(config.oidc, getKey) };
  }
  registerAuth(app, config, authDeps);

  // Consistent, safe error responses carrying the correlation id; internal detail hidden.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err, route: req.url }, 'unhandled request error');
    void reply.code(status).send({
      code: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status >= 500 ? 'Internal server error.' : err.message,
      correlationId: req.id,
    });
  });

  // Secure HTTP headers. CSP is disabled here because the API returns JSON and the
  // dev-only Swagger UI needs inline assets; all other helmet protections apply.
  await app.register(helmet, { contentSecurityPolicy: false });

  // OpenAPI. The document is generated from route schemas.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'RADAR API',
        version: '0.1.0',
        description:
          'RADAR — Réalta Delivery Analysis & Routing. RTÉ NS1 steering explainability (read-only v1).',
      },
      tags: [
        { name: 'health', description: 'Liveness and readiness' },
        { name: 'identity', description: 'Authenticated principal' },
        { name: 'ns1', description: 'Read-only NS1 configuration (GET-only)' },
        { name: 'dns', description: 'DNS steering explanation (read-only evaluation)' },
        { name: 'snapshots', description: 'Configuration snapshots and version history' },
        { name: 'audit', description: 'RADAR audit history (read-only)' },
        { name: 'change-detection', description: 'NS1 change-detection service status (read-only)' },
        { name: 'network-telemetry', description: 'CloudVision network telemetry (read-only)' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'OIDC access token (Microsoft Entra ID in production).',
          },
        },
      },
    },
  });

  // Swagger UI is exposed only in development.
  if (config.NODE_ENV === 'development') {
    await app.register(swaggerUi, { routePrefix: '/api/v1/docs' });
  }

  await app.register(healthRoutes, {
    prefix: '/api/v1/health',
    authMode: config.authMode,
    databaseHealth: deps.databaseHealth,
  });
  await app.register(meRoutes, { prefix: '/api/v1' });

  // Read-only NS1 + DNS explanation. The NS1 client is GET-only; in mock mode it needs no
  // credential. Tests may inject a fixture client via deps.
  const ns1Client = deps.ns1Client ?? createNs1Client(config.ns1);
  await app.register(ns1Routes, { prefix: '/api/v1/ns1', client: ns1Client, ns1: config.ns1, ns1Connection: deps.ns1Manager });
  await app.register(ns1AsnRoutes, { prefix: '/api/v1/ns1', client: ns1Client, ns1: config.ns1, resolver: deps.asnResolver, ns1Connection: deps.ns1Manager });
  await app.register(ns1ActiveRoutes, { prefix: '/api/v1/ns1', client: ns1Client, ns1: config.ns1, resolveCname: deps.ns1ActiveResolveCname, ns1Connection: deps.ns1Manager });
  await app.register(dnsRoutes, { prefix: '/api/v1/dns', client: ns1Client, ns1: config.ns1, ns1Connection: deps.ns1Manager });
  await app.register(snapshotRoutes, { prefix: '/api/v1', client: ns1Client, ns1: config.ns1, database: deps.database, ns1Connection: deps.ns1Manager });
  await app.register(ns1ConnectionRoutes, { prefix: '/api/v1', manager: deps.ns1Manager });
  // Guarded NS1 create-record path (dry-run + confirm). RADAR's only write to NS1; default-off.
  await app.register(ns1WriteRoutes, { prefix: '/api/v1', writer: deps.ns1RecordWriter ?? createNs1RecordWriter(config.ns1), readClient: ns1Client, audit: deps.database?.audit });
  await app.register(auditRoutes, { prefix: '/api/v1', database: deps.database });
  await app.register(changeDetectionRoutes, { prefix: '/api/v1', service: deps.changeDetection });
  await app.register(liveSteeringRoutes, { prefix: '/api/v1', store: deps.steeringStore });
  await app.register(telemetryRoutes, { prefix: '/api/v1', client: deps.telemetryClient, mode: deps.telemetryMode });
  await app.register(cacheTelemetryRoutes, { prefix: '/api/v1', client: deps.cacheTelemetryClient, mode: deps.cacheTelemetryMode });
  await app.register(dnsObservationRoutes, { prefix: '/api/v1', service: deps.dnsObservationService, repository: deps.dnsObservationRepository, staleAfterSeconds: deps.dnsObservationStaleAfterSeconds });
  await app.register(validationRoutes, { prefix: '/api/v1', service: deps.validationService, repository: deps.validationRepository });
  await app.register(cloudVisionRoutes, { prefix: '/api/v1', poller: deps.cloudVisionPoller, mode: deps.cloudVisionMode });
  await app.register(cloudflareRoutes, { prefix: '/api/v1', poller: deps.cloudflarePoller });
  await app.register(cloudflareConnectionRoutes, { prefix: '/api/v1', manager: deps.cloudflareManager });
  await app.register(fastlyRoutes, { prefix: '/api/v1', poller: deps.fastlyPoller, realtimeStreamer: deps.fastlyRealtimeStreamer });
  await app.register(akamaiRoutes, { prefix: '/api/v1', connector: deps.akamaiConnector });
  await app.register(akamaiConnectionRoutes, { prefix: '/api/v1', manager: deps.akamaiManager });
  await app.register(fastlyConnectionRoutes, { prefix: '/api/v1', manager: deps.fastlyManager });
  await app.register(cloudVisionConnectionRoutes, { prefix: '/api/v1', manager: deps.cloudVisionManager });
  await app.register(resolverRoutes, { prefix: '/api/v1', manager: deps.atlasManager ?? createAtlasManager(loadAtlasConfig()) });

  // Machine-readable spec, available in all environments; hidden from the spec itself.
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}

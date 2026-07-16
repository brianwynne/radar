// Read-only Akamai CDN observability routes + the DataStream 2 ingest endpoint. INFORMATIONAL only —
// RADAR issues no Akamai writes. Telemetry is aggregated from DS2 edge logs (pulled from S3, or
// pushed to the ingest route). The read routes require the usual RBAC; the ingest route is a
// data-plane endpoint authenticated by a shared secret (not a RADAR session), so it carries no
// requirePermission guard.
import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../auth/guards.js';
import type { AkamaiConnector } from '../akamai/index.js';
import type { AkamaiProvenance } from '../akamai/types.js';

export interface AkamaiRoutesOptions {
  connector?: AkamaiConnector;
  /** Max bytes accepted on the ingest route (DS2 batches are larger than the default API limit). */
  ingestBodyLimit?: number;
}

const DISABLED: AkamaiProvenance = {
  source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true,
  notice: 'Akamai connector is disabled.', retrievedAt: new Date(0).toISOString(),
};

const schema = (summary: string, description: string) => ({ tags: ['akamai'], summary, description, security: [{ bearerAuth: [] }] });

export const akamaiRoutes: FastifyPluginAsync<AkamaiRoutesOptions> = async (app, opts) => {
  const connector = opts.connector;
  const snapshot = () => connector?.snapshot() ?? null;

  app.get(
    '/cdn/akamai/status',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Akamai connector status', 'Read-only connector health: source, ingest freshness, records processed, and per-CP-code sample counts. No credentials.') },
    async () => connector?.status() ?? { source: 'disabled', aggregator: null, s3: null, ingestEnabled: false },
  );

  app.get(
    '/cdn/akamai/realtime',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Akamai real-time (DataStream 2)', 'Read-only per-CP-code per-second delivery telemetry aggregated from Akamai DataStream 2 edge logs: requests, bandwidth, cache hits and status-code mix over a rolling window.') },
    async () => {
      const snap = snapshot();
      if (!snap) return { provenance: DISABLED, source: 'disabled', windowSeconds: 0, series: [], warnings: [] };
      return { provenance: snap.provenance, source: snap.source, windowSeconds: snap.windowSeconds, series: snap.series, warnings: snap.warnings };
    },
  );

  app.get(
    '/cdn/akamai/services',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Akamai services (CP codes)', 'Read-only list of observed CP codes with their sample counts and freshness.') },
    async () => {
      const st = connector?.status();
      return { provenance: snapshot()?.provenance ?? DISABLED, count: st?.aggregator.services.length ?? 0, items: st?.aggregator.services ?? [] };
    },
  );

  // DataStream 2 ingest (HTTPS-push / replay). Shared-secret auth; raw NDJSON body (optionally gzip).
  // Registered only when a connector with an ingest secret is present.
  if (connector?.ingestEnabled()) {
    app.addContentTypeParser(['application/x-ndjson', 'application/gzip', 'application/octet-stream', 'text/plain'], { parseAs: 'buffer', bodyLimit: opts.ingestBodyLimit ?? 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    app.post(
      '/cdn/akamai/datastream/ingest',
      { bodyLimit: opts.ingestBodyLimit ?? 8 * 1024 * 1024, schema: { ...schema('DataStream 2 ingest', 'Accepts a DataStream 2 edge-log batch (NDJSON, optionally gzip). Shared-secret auth via the X-Radar-Ingest-Key header. Read-only aggregation — nothing is persisted or forwarded.'), security: [] } },
      async (req, reply) => {
        if (!connector.verifyIngestSecret(req.headers['x-radar-ingest-key'] as string | undefined)) {
          return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or missing ingest key.' });
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
        const accepted = connector.ingestUpload(body, req.headers['content-encoding'] as string | undefined);
        return { accepted };
      },
    );
  }
};

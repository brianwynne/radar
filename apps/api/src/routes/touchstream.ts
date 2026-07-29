// Read-only Touchstream delivery-monitoring routes.
//
// PROVENANCE, enforced in the envelope on every response: Touchstream probes from CLOUD/DATACENTRE
// vantage points, so this is OBSERVED SYNTHETIC delivery — it is not viewer traffic and must never be
// presented as RADAR's "actual traffic" tier. The envelope says so explicitly, so a consumer of the
// API cannot lose that qualification.
//
// Never returns the endpoint, the X-TS-ID app id, the bearer token, or raw vendor wire bodies.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import { buildHistory } from '../touchstream/adapter.js';
import { TouchstreamError, type TouchstreamClient } from '../touchstream/client.js';
import type { TouchstreamPoller } from '../touchstream/poller.js';

export interface TouchstreamRouteOptions {
  poller?: TouchstreamPoller;
  /** Client used for the on-demand windowed reads (stats / error log). */
  client?: TouchstreamClient;
  environment?: 'PROD' | 'NPROD';
  maxErrorEntries?: number;
}

const NOTICE =
  'Touchstream delivery monitoring is read-only and observational. Probes run from cloud/datacentre vantage points, so this is measured synthetic delivery — NOT viewer traffic, and not evidence of what a subscriber on any ISP received.';

/** Windowed history: a trailing window in minutes (default 24h, max 7 days). */
const historyQuery = z.object({
  minutes: z.coerce.number().int().min(5).max(7 * 24 * 60).optional(),
});

const DEFAULT_HISTORY_MINUTES = 24 * 60;

export const touchstreamRoutes: FastifyPluginAsync<TouchstreamRouteOptions> = async (app, opts) => {
  const now = () => new Date().toISOString();
  const mode = () => opts.poller?.status().source ?? 'disabled';
  const envelope = () => ({
    source: 'touchstream' as const,
    mode: mode(),
    readOnly: true,
    observational: true,
    /** The distinction RADAR must never blur. */
    tier: 'observed-synthetic' as const,
    notice: NOTICE,
    retrievedAt: now(),
  });
  const schema = (summary: string, description: string) => ({
    tags: ['touchstream-delivery'],
    summary,
    description,
    security: [{ bearerAuth: [] }],
  });

  app.get(
    '/touchstream/status',
    {
      preHandler: requirePermission('topology.summary.read'),
      schema: schema(
        'Touchstream connector status',
        'Read-only connector status (running, last poll, failures, snapshot age, Touchstream sample age and staleness). No credential or endpoint is returned.',
      ),
    },
    async () => ({
      provenance: envelope(),
      status:
        opts.poller?.status() ?? {
          enabled: false,
          running: false,
          source: 'disabled',
          intervalMs: 0,
          lastPollAt: null,
          lastSuccessAt: null,
          lastDurationMs: null,
          consecutiveFailures: 0,
          lastError: null,
          snapshotAgeSeconds: null,
          monitorCount: 0,
          oldestSampleAgeSeconds: null,
          stale: false,
        },
    }),
  );

  app.get(
    '/touchstream/delivery',
    {
      preHandler: requirePermission('topology.summary.read'),
      schema: schema(
        'Delivery matrix (channel × CDN)',
        'Read-only delivery status per channel/format/CDN with per-probe-location detail, edge-IP attribution, coverage and per-row comparability. An absent cell means NOT MONITORED — never healthy.',
      ),
    },
    async (_req, reply) => {
      const snapshot = opts.poller?.snapshot() ?? null;
      if (!snapshot) {
        // Honest empty: nothing measured yet is not the same as everything healthy.
        return {
          provenance: envelope(),
          snapshot: null,
          reason: opts.poller?.status().enabled === false ? 'connector disabled' : 'no snapshot captured yet',
          lastError: opts.poller?.status().lastError ?? null,
        };
      }
      void reply;
      return { provenance: envelope(), snapshot };
    },
  );

  app.get(
    '/touchstream/history',
    {
      preHandler: requirePermission('dns.explain.read'),
      schema: schema(
        'Windowed statistics + error log',
        'Read-only per-CDN aggregates (executions, requests, error/failure rates, response-time min/avg/max/p95) and individual failures over a trailing window. Fetched on demand from Touchstream; RADAR stores none of it.',
      ),
    },
    async (req, reply) => {
      const parsed = historyQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; '),
          correlationId: req.id,
        });
      }
      if (!opts.client) {
        return reply.code(503).send({ code: 'TOUCHSTREAM_DISABLED', message: 'The Touchstream connector is not configured.', correlationId: req.id });
      }
      const minutes = parsed.data.minutes ?? DEFAULT_HISTORY_MINUTES;
      const toMs = Date.now();
      const fromMs = toMs - minutes * 60_000;
      const environment = opts.environment ?? 'PROD';
      const query = { environment, startEpochSeconds: Math.floor(fromMs / 1000), endEpochSeconds: Math.floor(toMs / 1000) };
      try {
        // Both reads are independent; run them together so the window is fetched in one round trip.
        const [stats, errors] = await Promise.all([opts.client.fetchStats(query), opts.client.fetchErrors(query)]);
        return {
          provenance: envelope(),
          history: buildHistory({ stats, errors, fromMs, toMs, environment, maxErrors: opts.maxErrorEntries ?? 500 }),
        };
      } catch (err) {
        if (err instanceof TouchstreamError) {
          // 424: the upstream failed, not RADAR — and Cloudflare masks origin 5xx, so a 5xx would
          // reach the operator as a Cloudflare error page instead of this message.
          return reply.code(err.code === 'TOUCHSTREAM_AUTH' ? 502 : 424).send({
            code: err.code,
            message: err.message,
            correlationId: req.id,
          });
        }
        throw err;
      }
    },
  );
};

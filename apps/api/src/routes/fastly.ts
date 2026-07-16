// Read-only Fastly CDN observability routes. INFORMATIONAL only — RADAR issues no Fastly writes.
// Surfaces per-service delivery telemetry (requests, cache hit ratio, bandwidth, origin offload,
// status-code mix) for the Fastly commercial CDN. Never returns the API token.
import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../auth/guards.js';
import type { FastlyPoller } from '../fastly/poller.js';
import type { FastlyRealtimeStreamer } from '../fastly/realtime-streamer.js';
import type { FastlySnapshot } from '../fastly/types.js';

export interface FastlyRoutesOptions {
  poller?: FastlyPoller;
  realtimeStreamer?: FastlyRealtimeStreamer;
}

const DISABLED: FastlySnapshot['provenance'] = {
  source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true,
  notice: 'Fastly connector is disabled.', retrievedAt: new Date(0).toISOString(),
};

const schema = (summary: string, description: string) => ({ tags: ['fastly'], summary, description, security: [{ bearerAuth: [] }] });

export const fastlyRoutes: FastifyPluginAsync<FastlyRoutesOptions> = async (app, opts) => {
  const snapshot = (): FastlySnapshot | null => opts.poller?.latestSnapshot() ?? null;
  const provenance = () => snapshot()?.provenance ?? DISABLED;

  app.get(
    '/cdn/fastly/status',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Fastly connector status', 'Read-only connector health: mode, freshness, service count, last error, delivery summary and real-time live-tail status. No credentials.') },
    async () => ({ status: opts.poller?.status() ?? null, realtime: opts.realtimeStreamer?.status() ?? null, summary: snapshot()?.summary ?? null, provenance: provenance(), warnings: snapshot()?.warnings ?? [] }),
  );

  app.get(
    '/cdn/fastly/services',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Fastly services', 'Read-only per-service delivery telemetry: requests/s, cache hit ratio, bandwidth, origin offload and status-code mix over the observation window.') },
    async () => {
      const items = snapshot()?.services ?? [];
      return { provenance: provenance(), count: items.length, items };
    },
  );

  app.get(
    '/cdn/fastly/realtime',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Fastly real-time live-tail', 'Read-only per-second delivery samples (requests, bandwidth, cache hits, status mix) per service over a short rolling window, sourced from Fastly real-time analytics. Live-only; disabled in mock mode.') },
    async () => {
      const snap = opts.realtimeStreamer?.snapshot();
      if (!snap) return { provenance: DISABLED, source: 'disabled', windowSeconds: 0, series: [], warnings: [] };
      // Enrich per-second series with the human service name from the historical poller snapshot
      // (the streamer only knows service ids); fall back to whatever name it carries.
      const names = new Map((snapshot()?.services ?? []).map((s) => [s.serviceId, s.serviceName]));
      const series = snap.series.map((s) => ({ ...s, serviceName: names.get(s.serviceId) ?? s.serviceName }));
      return { provenance: snap.provenance, source: snap.source, windowSeconds: snap.windowSeconds, series, warnings: snap.warnings };
    },
  );
};

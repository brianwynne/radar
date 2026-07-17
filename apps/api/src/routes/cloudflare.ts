// Read-only Cloudflare Load Balancing routes. INFORMATIONAL only — RADAR issues no Cloudflare
// writes. Surfaces the origin-pool selection downstream of NS1: load balancers (steering policy
// + the pools they steer across), and pools (origins + health). Never returns the API token.
import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../auth/guards.js';
import type { CloudflarePoller } from '../cloudflare/poller.js';
import type { CloudflareSnapshot } from '../cloudflare/types.js';

export interface CloudflareRoutesOptions {
  poller?: CloudflarePoller;
}

const DISABLED: CloudflareSnapshot['provenance'] = {
  source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true,
  notice: 'Cloudflare connector is disabled.', retrievedAt: new Date(0).toISOString(),
};

/** Hard server-side cap on how many pools the fast focused-refresh will live-fetch per call. */
const MAX_FOCUS_POOLS = 8;

const schema = (summary: string, description: string) => ({ tags: ['cloudflare'], summary, description, security: [{ bearerAuth: [] }] });

export const cloudflareRoutes: FastifyPluginAsync<CloudflareRoutesOptions> = async (app, opts) => {
  const snapshot = (): CloudflareSnapshot | null => opts.poller?.latestSnapshot() ?? null;
  const provenance = () => snapshot()?.provenance ?? DISABLED;

  app.get(
    '/network/cloudflare/status',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Cloudflare connector status', 'Read-only connector health: mode, freshness, pool/load-balancer counts, last error. No credentials.') },
    async () => ({ status: opts.poller?.status() ?? null, summary: snapshot()?.summary ?? null, provenance: provenance(), warnings: snapshot()?.warnings ?? [] }),
  );

  app.get(
    '/network/cloudflare/load-balancers',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Cloudflare load balancers', 'Read-only load balancers with steering policy and the pools they steer across (resolved to names). Downstream of NS1; RADAR never modifies Cloudflare.') },
    async () => {
      const items = snapshot()?.loadBalancers ?? [];
      return { provenance: provenance(), count: items.length, items };
    },
  );

  app.get(
    '/network/cloudflare/pools',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Cloudflare origin pools', 'Read-only origin pools with their caches (origins), weights and Cloudflare health-monitor status.') },
    async () => {
      const items = snapshot()?.pools ?? [];
      return { provenance: provenance(), count: items.length, items };
    },
  );

  // Fast tier: live-refresh just the health+RTT of a small, capped set of pinned pools. The cap is a
  // hard server-side guard so a fast client poll can never exceed Cloudflare's API rate limits,
  // regardless of how many ids are requested.
  app.get(
    '/network/cloudflare/pools/refresh',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Cloudflare focused pool refresh', 'Fast tier: live health + RTT for up to a fixed number of pinned pools (bounded to protect Cloudflare rate limits). Steering/config still come from the slower full snapshot.') },
    async (req) => {
      const idsRaw = typeof (req.query as { ids?: unknown }).ids === 'string' ? (req.query as { ids: string }).ids : '';
      const requested = idsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const ids = requested.slice(0, MAX_FOCUS_POOLS);
      const pools = opts.poller ? await opts.poller.refreshPools(ids) : [];
      return { provenance: provenance(), pools, capped: requested.length > ids.length, max: MAX_FOCUS_POOLS };
    },
  );
};

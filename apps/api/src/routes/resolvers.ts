// Resolver-reader routes. Baseline (cached read of the recurring measurements), an on-demand
// "check now" (fires one-off measurements + polls their results), and a polling on/off switch that
// stops/starts the recurring measurements to control RIPE Atlas credit spend. INFORMATIONAL only;
// never returns the Atlas API key. Writes (create/stop measurements) require the manage permission.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { ResolverManager, ResolverSnapshot } from '../atlas/index.js';

export interface ResolverRoutesOptions {
  manager: ResolverManager;
  cacheTtlMs?: number;
  now?: () => number;
}

const checkBody = z.object({ checks: z.array(z.object({ isp: z.string(), asn: z.number().int(), measurementId: z.number().int() })) });
const pollingBody = z.object({ enabled: z.boolean() });
const schema = (summary: string, description: string) => ({ tags: ['network'], summary, description, security: [{ bearerAuth: [] }] });

export const resolverRoutes: FastifyPluginAsync<ResolverRoutesOptions> = async (app, opts) => {
  const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  let cache: { at: number; snap: ResolverSnapshot } | null = null;

  app.get(
    '/network/resolvers',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('ISP resolver reader (baseline)', "What each ISP's own recursive resolvers return for the steering record — platform, Cloudflare pool split, and the TTLs they serve. Read from the 6-hourly recurring RIPE Atlas measurements; cached briefly. No credentials.") },
    async () => {
      if (!cache || now() - cache.at > ttl) cache = { at: now(), snap: await opts.manager.snapshot() };
      return cache.snap;
    },
  );

  app.post(
    '/network/resolvers/check',
    { preHandler: requirePermission('connector.manage'), schema: schema('Check resolvers now', 'Fire a one-off RIPE Atlas DNS measurement per covered ISP and return the handles to poll. Spends Atlas credits (user-initiated).') },
    async () => opts.manager.checkNow(),
  );

  app.post(
    '/network/resolvers/check/results',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Check-now results', 'Aggregate the results of an on-demand check. `pending` is true until every covered ISP has reported.') },
    async (req) => {
      const parsed = checkBody.safeParse(req.body);
      if (!parsed.success) return { error: 'invalid checks' };
      return opts.manager.checkResults(parsed.data.checks);
    },
  );

  app.post(
    '/network/resolvers/polling',
    { preHandler: requirePermission('connector.manage'), schema: schema('Toggle recurring polling', 'Turn the 6-hourly recurring measurements on or off. Off STOPS them on RIPE Atlas to halt credit spend; on re-creates them.') },
    async (req) => {
      const parsed = pollingBody.safeParse(req.body);
      if (!parsed.success) return { error: 'invalid body' };
      return opts.manager.setPolling(parsed.data.enabled);
    },
  );
};

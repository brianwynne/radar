// Dashboard aggregate endpoints (read-only). The delivery split powers the top-of-page pie:
// live delivery to each eyeball network (Réalta) and by the commercial CDNs (Fastly/Akamai),
// with the total live throughput and a 1-hour average from persisted samples.
import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../auth/guards.js';
import { computeDeliverySplit } from '../dashboard/delivery.js';
import type { DeliverySampleRepository } from '@radar/data';
import type { CloudVisionPoller } from '../cloudvision/poller.js';
import type { FastlyPoller } from '../fastly/poller.js';
import type { AkamaiConnector } from '../akamai/index.js';

export interface DashboardRouteOptions {
  cloudVisionPoller?: CloudVisionPoller;
  fastlyPoller?: FastlyPoller;
  akamaiConnector?: AkamaiConnector;
  deliveryRepo?: DeliverySampleRepository;
}

export const dashboardRoutes: FastifyPluginAsync<DashboardRouteOptions> = async (app, opts) => {
  app.get(
    '/dashboard/delivery',
    {
      preHandler: requirePermission('dashboard.read'),
      schema: {
        tags: ['dashboard'],
        summary: 'Live delivery split (Réalta eyeball + commercial CDNs) with a 1-hour average',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const live = computeDeliverySplit(
        opts.cloudVisionPoller?.getLatest() ?? null,
        opts.fastlyPoller?.latestSnapshot() ?? null,
        opts.akamaiConnector?.snapshot() ?? null,
      );
      const average = opts.deliveryRepo
        ? await opts.deliveryRepo.averageSince(new Date(Date.now() - 60 * 60_000))
        : { avgRealtaBps: null, avgCommercialBps: null, avgTotalBps: null, sampleCount: 0 };
      return { live, average: { ...average, windowMinutes: 60 } };
    },
  );
};

// Read-only status of the Change Detection service. No control actions (no start/stop over
// HTTP). Exposes checkpoint/health for observability; never leaks upstream detail.
import type { FastifyPluginAsync } from 'fastify';
import type { ChangeDetectionService } from '../change-detection/index.js';
import { requirePermission } from '../auth/guards.js';

export interface ChangeDetectionRouteOptions {
  service?: ChangeDetectionService;
}

export const changeDetectionRoutes: FastifyPluginAsync<ChangeDetectionRouteOptions> = async (app, opts) => {
  app.get(
    '/change-detection/status',
    {
      preHandler: requirePermission('dashboard.read'),
      schema: {
        tags: ['change-detection'],
        summary: 'Change Detection service status',
        description:
          'Read-only status of the NS1 Activity-API change-detection service (checkpoint, last run/success, consecutive failures, events published). No control actions are exposed over HTTP.',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      if (!opts.service) {
        return { enabled: false, running: false, source: 'ns1-activity-poll', intervalMs: 0, lastRunAt: null, lastSuccessAt: null, checkpoint: null, consecutiveFailures: 0, eventsPublished: 0, lastError: null };
      }
      return opts.service.status();
    },
  );
};

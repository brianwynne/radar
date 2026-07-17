// Read-only: the currently-active steering record, discovered by resolving the public entry's CNAME
// (live.rte.ie → the active nsone record) and reading that record's config. Lets the UI default to
// and watch the record that is actually steering traffic right now, which changes when RTÉ re-points
// the entry.
import type { FastifyPluginAsync } from 'fastify';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { Ns1Config } from '../ns1/config.js';
import { Ns1Error } from '../ns1/errors.js';
import { requirePermission } from '../auth/guards.js';
import { buildProvenance, sendNs1Error } from './ns1-helpers.js';
import { resolveActiveRecord, DEFAULT_ACTIVE_ENTRY, type CnameResolver } from '../ns1/active-record.js';

export interface Ns1ActiveRouteOptions {
  client: Ns1ReadClient;
  ns1: Ns1Config;
  entry?: string; // public entry whose CNAME points at the active record (default: live.rte.ie)
  resolveCname?: CnameResolver; // injectable for tests; defaults to the system resolver
}

export const ns1ActiveRoutes: FastifyPluginAsync<Ns1ActiveRouteOptions> = async (app, opts) => {
  const { client, ns1 } = opts;
  const entry = opts.entry ?? DEFAULT_ACTIVE_ENTRY;

  app.get(
    '/active-record',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['ns1'], summary: 'Resolve the currently-active steering record (follows the entry CNAME over DNS)', security: [{ bearerAuth: [] }] } },
    async (req, reply) => {
      const retrievedAt = new Date().toISOString();
      try {
        const zonesRaw = await client.listZones(req.id);
        const zones = Array.isArray(zonesRaw)
          ? (zonesRaw.map((z) => (z as { zone?: string }).zone).filter((z): z is string => typeof z === 'string'))
          : [];
        const result = await resolveActiveRecord(client, zones, entry, { resolveCname: opts.resolveCname, correlationId: req.id });
        return {
          provenance: buildProvenance(ns1, result.active ? `/v1/zones/${result.active.zone}/${result.active.domain}/${result.active.type}` : `dns:${entry}`, retrievedAt),
          ...result,
        };
      } catch (err) {
        if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
        throw err;
      }
    },
  );
};

// Read-only NS1 routes (docs/ns1/developer-guide.md §4). All are GET; there is no write
// route and no generic proxy. Every payload carries provenance identifying the mode and,
// in mock mode, that the data is synthetic/non-production. RBAC is enforced server-side.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { Ns1Config } from '../ns1/config.js';
import { Ns1Error } from '../ns1/errors.js';
import { normaliseRecord } from '../ns1/normalise.js';
import { requirePermission } from '../auth/guards.js';
import { buildProvenance, sendNs1Error } from './ns1-helpers.js';

export interface Ns1RouteOptions {
  client: Ns1ReadClient;
  ns1: Ns1Config;
}

const doc = (summary: string) => ({ tags: ['ns1'], summary, security: [{ bearerAuth: [] }] }) as const;

/** Run an NS1 read and wrap it with provenance, translating NS1 errors to safe responses. */
async function read(
  req: FastifyRequest,
  reply: FastifyReply,
  ns1: Ns1Config,
  endpoint: string,
  fetchIt: () => Promise<Record<string, unknown>>,
): Promise<unknown> {
  const retrievedAt = new Date().toISOString();
  try {
    const body = await fetchIt();
    return { provenance: buildProvenance(ns1, endpoint, retrievedAt), ...body };
  } catch (err) {
    if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
    throw err;
  }
}

export const ns1Routes: FastifyPluginAsync<Ns1RouteOptions> = async (app, opts) => {
  const { client, ns1 } = opts;

  // Mode/status banner — visible to any dashboard viewer so the UI can label mock data.
  app.get('/config', { preHandler: requirePermission('dashboard.read'), schema: doc('NS1 read-only mode and status') }, async () => ({
    mode: ns1.mode,
    synthetic: ns1.mode === 'mock',
    readOnly: true,
    disclaimer: ns1.mode === 'mock' ? 'SYNTHETIC / MOCK NS1 data — not real RTÉ or NS1 configuration.' : undefined,
  }));

  app.get('/zones', { preHandler: requirePermission('ns1.detail.read'), schema: doc('List NS1 zones') }, (req, reply) =>
    read(req, reply, ns1, '/v1/zones', async () => ({ zones: await client.listZones(req.id) })),
  );

  app.get('/zones/:zone', { preHandler: requirePermission('ns1.detail.read'), schema: doc('Get a complete NS1 zone') }, (req, reply) => {
    const { zone } = req.params as { zone: string };
    return read(req, reply, ns1, `/v1/zones/${zone}`, async () => ({ zone: await client.getZone(zone, req.id) }));
  });

  // RADAR-normalised record view (engine input shape; unknown fields preserved).
  app.get(
    '/zones/:zone/:domain/:type',
    { preHandler: requirePermission('ns1.detail.read'), schema: doc('Get a normalised NS1 record') },
    (req, reply) => {
      const { zone, domain, type } = req.params as { zone: string; domain: string; type: string };
      return read(req, reply, ns1, `/v1/zones/${zone}/${domain}/${type}`, async () => ({
        record: normaliseRecord(await client.getRecord(zone, domain, type, req.id)),
      }));
    },
  );

  // Raw record exactly as returned by NS1 (raw preservation; higher-privilege).
  app.get(
    '/zones/:zone/:domain/:type/raw',
    { preHandler: requirePermission('ns1.raw.read'), schema: doc('Get the raw NS1 record') },
    (req, reply) => {
      const { zone, domain, type } = req.params as { zone: string; domain: string; type: string };
      return read(req, reply, ns1, `/v1/zones/${zone}/${domain}/${type}`, async () => ({
        raw: await client.getRecord(zone, domain, type, req.id),
      }));
    },
  );
};

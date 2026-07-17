// Read-only ASN breakdown for a record: every ASN referenced by the record's answers, resolved to
// its network owner (RIPEstat) and shown with the delivery answers/platforms it is tagged in. GET
// only; ASN ownership is external (not in NS1), so it carries the resolver source in the payload.
import type { FastifyPluginAsync } from 'fastify';
import { deliveryPlatformOf } from '@radar/engine';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { Ns1Config } from '../ns1/config.js';
import type { AsnResolver } from '../ns1/asn-resolver.js';
import { createRipestatResolver } from '../ns1/asn-resolver.js';
import { Ns1Error } from '../ns1/errors.js';
import { normaliseRecord } from '../ns1/normalise.js';
import { requirePermission } from '../auth/guards.js';
import { buildProvenance, sendNs1Error } from './ns1-helpers.js';

export interface Ns1AsnRouteOptions {
  client: Ns1ReadClient;
  ns1: Ns1Config;
  resolver?: AsnResolver; // injectable for tests; defaults to RIPEstat
}

interface AnswerTag {
  answerId: string | null;
  note: string | null;
  platform: string | null;
  weight: number | null;
}

export const ns1AsnRoutes: FastifyPluginAsync<Ns1AsnRouteOptions> = async (app, opts) => {
  const { client, ns1 } = opts;
  const resolver = opts.resolver ?? createRipestatResolver();

  app.get<{ Params: { zone: string; domain: string; type: string } }>(
    '/asn-breakdown/:zone/:domain/:type',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['ns1'], summary: 'Resolve every ASN in a record to its network owner', security: [{ bearerAuth: [] }] } },
    async (req, reply) => {
      const { zone, domain, type } = req.params;
      const retrievedAt = new Date().toISOString();
      try {
        const record = normaliseRecord(await client.getRecord(zone, domain, type, req.id));

        // Which delivery answers each ASN is tagged in (one ASN can appear in several answers).
        const tagsByAsn = new Map<number, AnswerTag[]>();
        for (const a of record.answers) {
          const meta = a.meta?.asn;
          const asns = Array.isArray(meta) ? meta.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
          if (asns.length === 0) continue;
          const tag: AnswerTag = {
            answerId: a.id ?? null,
            note: typeof a.meta?.note === 'string' ? a.meta.note : null,
            platform: deliveryPlatformOf(a) ?? null,
            weight: typeof a.meta?.weight === 'number' ? a.meta.weight : null,
          };
          for (const asn of asns) {
            const arr = tagsByAsn.get(asn) ?? [];
            arr.push(tag);
            tagsByAsn.set(asn, arr);
          }
        }

        const uniqueAsns = [...tagsByAsn.keys()].sort((x, y) => x - y);
        const holders = await resolver.resolve(uniqueAsns);
        const rows = uniqueAsns.map((asn) => {
          const holder = holders.get(asn) ?? null;
          return { asn, holder, resolved: holder !== null, tags: tagsByAsn.get(asn)! };
        });
        const resolvedCount = rows.filter((r) => r.resolved).length;

        return {
          provenance: buildProvenance(ns1, `/v1/zones/${zone}/${domain}/${type}`, retrievedAt),
          record: { zone, domain, type },
          source: resolver.source,
          asnCount: uniqueAsns.length,
          resolvedCount,
          unresolvedCount: uniqueAsns.length - resolvedCount,
          rows,
        };
      } catch (err) {
        if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
        throw err;
      }
    },
  );
};

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
import { buildProvenance, resolveEffectiveNs1, sendNs1Error, type Ns1Connection } from './ns1-helpers.js';

export interface Ns1AsnRouteOptions {
  client: Ns1ReadClient;
  ns1: Ns1Config;
  /** Effective (live⇄mock) mode source so provenance reflects the live connector. */
  ns1Connection?: Ns1Connection;
  resolver?: AsnResolver; // injectable for tests; defaults to RIPEstat
}

interface AnswerTag {
  answerId: string | null;
  note: string | null;
  platform: string | null;
  weight: number | null;
}

export const ns1AsnRoutes: FastifyPluginAsync<Ns1AsnRouteOptions> = async (app, opts) => {
  const { client, ns1, ns1Connection } = opts;
  const resolver = opts.resolver ?? createRipestatResolver();

  // Generic ASN → owner resolution for the record editor (arbitrary ASN numbers, not tied to a
  // record). GET /ns1/asn-owners?asns=1,2,3 → { source, owners: { "1": "Owner", ... } }.
  app.get<{ Querystring: { asns?: string } }>(
    '/asn-owners',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['ns1'], summary: 'Resolve ASN numbers to network owners', security: [{ bearerAuth: [] }] } },
    async (req) => {
      const asns = [...new Set((req.query.asns ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 4294967295))].slice(0, 256);
      if (asns.length === 0) return { source: resolver.source, owners: {} };
      const map = await resolver.resolve(asns);
      const owners: Record<string, string> = {};
      for (const [asn, holder] of map) if (holder) owners[String(asn)] = holder;
      return { source: resolver.source, owners };
    },
  );

  app.get<{ Params: { zone: string; domain: string; type: string } }>(
    '/asn-breakdown/:zone/:domain/:type',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['ns1'], summary: 'Resolve every ASN in a record to its network owner', security: [{ bearerAuth: [] }] } },
    async (req, reply) => {
      const { zone, domain, type } = req.params;
      const retrievedAt = new Date().toISOString();
      try {
        const record = normaliseRecord(await client.getRecord(zone, domain, type, req.id));

        // Two views over the same data. Per-ANSWER groups (in configured order) are the useful
        // "each part of the chain" view; the per-NETWORK rows invert it (which answers a network
        // is tagged in). Both reference the same resolved holder map.
        const tagsByAsn = new Map<number, AnswerTag[]>();
        const groups: { answerId: string | null; note: string | null; platform: string | null; weight: number | null; target: string; asns: number[] }[] = [];
        record.answers.forEach((a, i) => {
          const meta = a.meta?.asn;
          const asns = Array.isArray(meta) ? meta.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
          if (asns.length === 0) return;
          const answerId = a.id ?? `answer-${i}`;
          const note = typeof a.meta?.note === 'string' ? a.meta.note : null;
          const platform = deliveryPlatformOf(a) ?? null;
          const weight = typeof a.meta?.weight === 'number' ? a.meta.weight : null;
          groups.push({ answerId, note, platform, weight, target: a.answer.join(', '), asns });
          for (const asn of asns) {
            const arr = tagsByAsn.get(asn) ?? [];
            arr.push({ answerId, note, platform, weight });
            tagsByAsn.set(asn, arr);
          }
        });

        const uniqueAsns = [...tagsByAsn.keys()].sort((x, y) => x - y);
        const holders = await resolver.resolve(uniqueAsns);
        const rows = uniqueAsns.map((asn) => {
          const holder = holders.get(asn) ?? null;
          return { asn, holder, resolved: holder !== null, tags: tagsByAsn.get(asn)! };
        });
        const answers = groups.map((g) => ({
          answerId: g.answerId,
          note: g.note,
          platform: g.platform,
          weight: g.weight,
          target: g.target,
          asnCount: g.asns.length,
          networks: g.asns
            .map((asn) => ({ asn, holder: holders.get(asn) ?? null }))
            .sort((x, y) => (x.holder ?? '').localeCompare(y.holder ?? '') || x.asn - y.asn),
        }));
        const resolvedCount = rows.filter((r) => r.resolved).length;

        return {
          provenance: buildProvenance(resolveEffectiveNs1(ns1, ns1Connection), `/v1/zones/${zone}/${domain}/${type}`, retrievedAt),
          record: { zone, domain, type },
          source: resolver.source,
          asnCount: uniqueAsns.length,
          resolvedCount,
          unresolvedCount: uniqueAsns.length - resolvedCount,
          answers,
          rows,
        };
      } catch (err) {
        if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
        throw err;
      }
    },
  );
};

// DNS steering explanation (the frontend's core vertical slice). Fetches a record via the
// read-only NS1 client, normalises it, and runs @radar/engine against a supplied scenario
// to produce the graphical evaluation contract (per-filter traces, derived identity,
// eligible answers, expected probabilistic distribution). Read-only: no NS1 write occurs.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { evaluate, type Scenario } from '@radar/engine';
import { Ns1Error } from '../ns1/errors.js';
import { normaliseRecord } from '../ns1/normalise.js';
import { requirePermission } from '../auth/guards.js';
import type { Ns1RouteOptions } from './ns1.js';
import { buildProvenance, resolveEffectiveNs1, sendNs1Error } from './ns1-helpers.js';

const bodySchema = z.object({
  zone: z.string().min(1),
  domain: z.string().min(1),
  type: z.string().min(1),
  scenario: z.object({
    resolverIp: z.string().min(1),
    ecsPresent: z.boolean().default(false),
    ecsPrefix: z.string().optional(),
    country: z.string().optional(),
    asn: z.number().int().optional(),
    network: z.string().optional(),
    clientPrefix: z.string().optional(),
    healthOverrides: z.record(z.string(), z.boolean()).optional(),
  }),
});

const explainSchema = {
  tags: ['dns'],
  summary: 'Explain how a DNS request is steered to a delivery platform',
  description:
    'Read-only. Evaluates the NS1 Filter Chain for a record against a hypothetical or observed request scenario and returns a filter-by-filter explanation. RADAR explains NS1 platform selection only; it never writes to NS1.',
  security: [{ bearerAuth: [] }],
} as const;

export const dnsRoutes: FastifyPluginAsync<Ns1RouteOptions> = async (app, opts) => {
  const { client, ns1, ns1Connection } = opts;

  app.post('/explain', { preHandler: requirePermission('dns.explain.read'), schema: explainSchema }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
      return reply.code(400).send({ code: 'INVALID_REQUEST', message, correlationId: req.id });
    }
    const { zone, domain, type, scenario } = parsed.data;
    const retrievedAt = new Date().toISOString();
    try {
      const record = normaliseRecord(await client.getRecord(zone, domain, type, req.id));
      const fullScenario: Scenario = { qname: domain, qtype: type.toUpperCase(), ...scenario };
      const evaluation = evaluate(record, fullScenario);
      return {
        provenance: buildProvenance(resolveEffectiveNs1(ns1, ns1Connection), `/v1/zones/${zone}/${domain}/${type}`, retrievedAt),
        request: { zone, domain, type, scenario: fullScenario },
        evaluation,
      };
    } catch (err) {
      if (err instanceof Ns1Error) return sendNs1Error(req, reply, err);
      throw err;
    }
  });
};

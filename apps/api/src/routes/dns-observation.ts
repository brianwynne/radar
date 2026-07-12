// Read-only DNS observation routes (Tier-2). Verifies what resolvers actually return for the
// configured ISP scenarios and compares against RADAR's predicted NS1 evaluation. Three
// clearly-separated tiers are surfaced: PREDICTED DNS steering, OBSERVED DNS answer, and
// ACTUAL traffic (which stays "telemetry not connected"). RADAR never writes to NS1 or
// Cloudflare and never claims anything about actual delivered traffic.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { DnsObservationRecord, DnsObservationRepository } from '@radar/data';
import type { DnsObservationService } from '../dns-observation/index.js';

export interface DnsObservationRouteOptions {
  service?: DnsObservationService;
  repository?: DnsObservationRepository;
  staleAfterSeconds?: number;
}

const TIER_LABELS = { predicted: 'Predicted DNS steering', observed: 'Observed DNS answer', traffic: 'Actual traffic — telemetry not connected' };

const runSchema = z.object({ ispId: z.string().max(120).optional() });
const historySchema = z.object({
  isp: z.string().max(120).optional(),
  resolver: z.string().max(80).optional(),
  domain: z.string().max(255).optional(),
  type: z.string().max(16).optional(),
  status: z.enum(['match', 'partial_match', 'mismatch', 'observation_unavailable', 'confidence_low', 'unknown']).optional(),
  checksum: z.string().max(120).optional(),
  since: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

function present(record: DnsObservationRecord, staleAfterSeconds: number, nowMs: number): Record<string, unknown> {
  const prov = (record.provenance ?? {}) as Record<string, unknown>;
  const ageSeconds = Math.max(0, (nowMs - record.observedAt.getTime()) / 1000);
  return {
    id: record.id,
    observedAt: record.observedAt,
    freshness: { ageSeconds, staleAfterSeconds, fresh: ageSeconds <= staleAfterSeconds },
    ispId: record.ispId,
    ispName: record.ispName,
    asn: record.asn,
    resolverIp: record.resolverIp,
    zone: record.zone,
    domain: record.domain,
    recordType: record.recordType,
    responseCode: record.responseCode,
    ecsRequested: record.ecsRequested,
    ecsPrefix: record.ecsPrefix,
    ecsHonoured: record.ecsHonoured,
    ttl: record.ttl,
    latencyMs: record.latencyMs,
    confidence: record.confidence,
    comparisonStatus: record.comparisonStatus,
    matchStatus: prov.matchStatus,
    differences: prov.differences ?? [],
    observedAnswers: record.observedAnswers,
    predictedAnswers: record.predictedAnswers,
    predictedDistribution: prov.distribution ?? [],
    observedOrder: prov.observedOrder ?? [],
    recordChecksum: record.recordChecksum,
    explanation: record.explanation,
    warnings: record.warnings,
    provenance: { source: 'radar', label: 'Observed DNS answer', readOnly: true },
  };
}

export const dnsObservationRoutes: FastifyPluginAsync<DnsObservationRouteOptions> = async (app, opts) => {
  const staleAfterSeconds = opts.staleAfterSeconds ?? 900;

  app.get(
    '/dns-observation/config',
    {
      preHandler: requirePermission('dns.explain.read'),
      schema: { tags: ['dns-observation'], summary: 'DNS observation configuration', description: 'Configured ISP observation scenarios (resolver addresses are RADAR-owned placeholders until confirmed), tier labels and the comparison/reason vocabularies. Read-only.', security: [{ bearerAuth: [] }] },
    },
    async () => ({
      provenance: { source: 'radar', readOnly: true, retrievedAt: new Date().toISOString() },
      mode: opts.service?.mode ?? 'disabled',
      staleAfterSeconds,
      tierLabels: TIER_LABELS,
      comparisonStatuses: ['match', 'partial_match', 'mismatch', 'observation_unavailable', 'confidence_low', 'unknown'],
      confidenceLevels: ['high', 'medium', 'low', 'unknown'],
      scenarios: (opts.service?.getScenarios() ?? []).map((s) => ({
        ispId: s.ispId, ispName: s.ispName, asn: s.asn, country: s.country, resolvers: s.resolvers,
        ecsSubnet: s.ecsSubnet, zone: s.zone, domain: s.domain, recordType: s.recordType,
        expectedRepresentativeness: s.expectedRepresentativeness, provenance: s.provenance, notes: s.notes,
      })),
    }),
  );

  app.get(
    '/dns-observation/state',
    {
      preHandler: requirePermission('dns.explain.read'),
      schema: { tags: ['dns-observation'], summary: 'Latest observed-DNS state per ISP', description: 'The latest DNS observation per configured ISP and its predicted-vs-observed comparison. This is the OBSERVED DNS answer tier — not actual traffic.', security: [{ bearerAuth: [] }] },
    },
    async () => {
      const scenarios = opts.service?.getScenarios() ?? [];
      const latest = opts.repository ? await opts.repository.latestPerIsp() : [];
      const byIsp = new Map(latest.map((r) => [r.ispId, r] as const));
      const now = Date.now();
      return {
        provenance: { source: 'radar', readOnly: true, retrievedAt: new Date().toISOString() },
        tierLabels: TIER_LABELS,
        count: scenarios.length,
        items: scenarios.map((s) => {
          const rec = byIsp.get(s.ispId);
          return { ispId: s.ispId, ispName: s.ispName, asn: s.asn, observation: rec ? present(rec, staleAfterSeconds, now) : null };
        }),
      };
    },
  );

  app.post(
    '/dns-observation/run',
    {
      preHandler: requirePermission('dns.observed.run'),
      schema: { tags: ['dns-observation'], summary: 'Run a DNS observation', description: 'Manually run a read-only DNS observation for one ISP (or all) and return the predicted-vs-observed comparison. Performs a single DNS query per ISP; never writes to NS1 or Cloudflare.', security: [{ bearerAuth: [] }] },
    },
    async (req, reply) => {
      if (!opts.service) return reply.code(503).send({ code: 'OBSERVATION_UNAVAILABLE', message: 'DNS observation is not configured.', correlationId: req.id });
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => i.message).join('; '), correlationId: req.id });
      const ispIds = parsed.data.ispId ? [parsed.data.ispId] : opts.service.getScenarios().map((s) => s.ispId);
      if (parsed.data.ispId && !opts.service.findScenario(parsed.data.ispId)) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown ISP scenario.', correlationId: req.id });
      }
      const now = Date.now();
      const results = [];
      for (const ispId of ispIds) {
        const outcome = await opts.service.run(ispId, req.id);
        if (outcome?.record) results.push(present(outcome.record, staleAfterSeconds, now));
        else if (outcome) results.push({ ispId, ispName: outcome.scenario.ispName, comparisonStatus: outcome.comparison.comparisonStatus, confidence: outcome.comparison.confidence, explanation: outcome.comparison.explanation, differences: outcome.comparison.differences, persisted: false });
      }
      return { provenance: { source: 'radar', readOnly: true, retrievedAt: new Date().toISOString() }, tierLabels: TIER_LABELS, count: results.length, results };
    },
  );

  app.get(
    '/dns-observation/history',
    {
      preHandler: requirePermission('dns.explain.read'),
      schema: { tags: ['dns-observation'], summary: 'DNS observation history', description: 'Bounded observation history (newest first). Filters: isp, resolver, domain, type, status, checksum, since, before, limit (max 500).', security: [{ bearerAuth: [] }] },
    },
    async (req, reply) => {
      if (!opts.repository) return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'DNS observation history is not configured.', correlationId: req.id });
      const parsed = historySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; '), correlationId: req.id });
      const q = parsed.data;
      const now = Date.now();
      const rows = await opts.repository.list({ ispId: q.isp, resolverIp: q.resolver, domain: q.domain, recordType: q.type, comparisonStatus: q.status, recordChecksum: q.checksum, since: q.since, before: q.before, limit: q.limit });
      return { provenance: { source: 'radar', readOnly: true, retrievedAt: new Date().toISOString() }, count: rows.length, items: rows.map((r) => present(r, staleAfterSeconds, now)) };
    },
  );
};

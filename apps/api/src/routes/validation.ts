// Read-only NS1 production-readiness validation routes. Validation NEVER writes to NS1. The
// run request is deliberately narrow (zone / optional domain+type / includeActivity /
// includeRaw) — no arbitrary URL, no caller-supplied key or payload, no write method. Raw
// (always sanitised) is gated on ns1.raw.read; results never contain credentials.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { ValidationResultRecord, ValidationResultRepository } from '@radar/data';
import type { ValidationService } from '../validation/index.js';
import type { ValidationResult } from '../validation/types.js';

export interface ValidationRouteOptions {
  service?: ValidationService;
  repository?: ValidationResultRepository;
}

const READ_ONLY_NOTICE = 'Validation is read-only. RADAR has not modified NS1.';

const runSchema = z
  .object({
    zone: z.string().min(1).max(255),
    domain: z.string().max(255).optional(),
    recordType: z.string().max(16).optional(),
    includeActivity: z.boolean().optional(),
    includeRaw: z.boolean().optional(),
  })
  .strict(); // reject any field not in the allow-list (no arbitrary URL/key/payload)

const listSchema = z.object({
  zone: z.string().max(255).optional(),
  domain: z.string().max(255).optional(),
  type: z.string().max(16).optional(),
  endpoint: z.enum(['zones', 'zone', 'record', 'activity']).optional(),
  status: z.enum(['compatible', 'compatible_with_warnings', 'partial', 'incompatible', 'unavailable']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

/** A run result → response view. sanitisedSample/fixtureCandidate are already gated in the
 *  service; here we just pass them through. */
function runView(r: ValidationResult): Record<string, unknown> {
  return { ...r };
}

/** A persisted record → response view; sanitisedSample only with ns1.raw.read. */
function recordView(rec: ValidationResultRecord, canRaw: boolean): Record<string, unknown> {
  const unknown = (rec.unknownFields ?? {}) as { metadata?: string[]; unexpected?: string[]; features?: unknown[]; schemaIssues?: string[] };
  return {
    id: rec.id,
    ranAt: rec.ranAt,
    endpoint: rec.endpoint,
    zone: rec.zone,
    domain: rec.domain,
    recordType: rec.recordType,
    sourceMode: rec.sourceMode,
    retrievedAt: rec.retrievedAt,
    rawChecksum: rec.rawChecksum,
    structuralChecksum: rec.structuralChecksum,
    overallStatus: rec.overallStatus,
    schemaCompatible: rec.schemaCompatible,
    adapterCompatible: rec.adapterCompatible,
    supportedFilters: rec.supportedFilters,
    unsupportedFilters: rec.unsupportedFilters,
    unknownMetadataFields: unknown.metadata ?? [],
    unexpectedFields: unknown.unexpected ?? [],
    unsupportedFeatures: unknown.features ?? [],
    schemaIssues: unknown.schemaIssues ?? [],
    missingExpectedFields: rec.missingFields,
    fieldTypeMismatches: rec.typeMismatches,
    answerGroupsPresent: rec.answerGroupsPresent,
    feedControlledMetadataPresent: rec.feedControlledPresent,
    ecs: rec.ecs,
    fixtureComparison: rec.fixtureComparison,
    warnings: rec.warnings,
    ...(canRaw ? { sanitisedSample: rec.sanitisedSample } : {}),
  };
}

export const validationRoutes: FastifyPluginAsync<ValidationRouteOptions> = async (app, opts) => {
  const envelope = () => ({ source: 'radar' as const, readOnly: true, notice: READ_ONLY_NOTICE, retrievedAt: new Date().toISOString() });

  app.post(
    '/validation/ns1/run',
    {
      preHandler: requirePermission('validation.run'),
      schema: { tags: ['validation'], summary: 'Run read-only NS1 validation', description: 'Validate live/mock NS1 data against RADAR runtime schemas, adapter and fixtures. Read-only — never writes to NS1. Accepts only zone/domain/recordType/includeActivity/includeRaw.', security: [{ bearerAuth: [] }] },
    },
    async (req, reply) => {
      if (!opts.service) return reply.code(503).send({ code: 'VALIDATION_UNAVAILABLE', message: 'Validation is not configured.', correlationId: req.id });
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '), correlationId: req.id });
      const blocked = opts.service.blockedReason();
      if (blocked) return reply.code(409).send({ code: blocked, message: 'Live NS1 validation is disabled. Set NS1_VALIDATION_ENABLED=true to allow it.', correlationId: req.id });

      const canViewRaw = req.principal!.permissions.includes('ns1.raw.read');
      const results = await opts.service.run(parsed.data, { includeRaw: parsed.data.includeRaw, canViewRaw, correlationId: req.id });
      const rawDenied = parsed.data.includeRaw && !canViewRaw;
      return { provenance: envelope(), mode: opts.service.mode, rawWithheld: rawDenied || undefined, count: results.length, results: results.map(runView) };
    },
  );

  app.get(
    '/validation/ns1/results',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['validation'], summary: 'NS1 validation results', description: 'Bounded validation-result history (newest first). Filters: zone, domain, type, endpoint, status, limit (≤500). Never returns credentials.', security: [{ bearerAuth: [] }] } },
    async (req, reply) => {
      if (!opts.repository) return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Validation history is not configured.', correlationId: req.id });
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => i.message).join('; '), correlationId: req.id });
      const q = parsed.data;
      const rows = await opts.repository.list({ zone: q.zone, domain: q.domain, recordType: q.type, endpoint: q.endpoint, overallStatus: q.status, limit: q.limit });
      // The list view never includes the sanitised sample (fetch a single result for that).
      return { provenance: envelope(), mode: opts.service?.mode, count: rows.length, items: rows.map((r) => recordView(r, false)) };
    },
  );

  app.get(
    '/validation/ns1/results/:resultId',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['validation'], summary: 'One NS1 validation result', description: 'A single validation result. The sanitised (credential-redacted) raw sample is included only with ns1.raw.read. 404 if unknown.', security: [{ bearerAuth: [] }] } },
    async (req, reply) => {
      if (!opts.repository) return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Validation history is not configured.', correlationId: req.id });
      const { resultId } = req.params as { resultId: string };
      // Guard the UUID before it reaches the `uuid` column — a malformed id would otherwise raise a
      // Postgres 22P02 and surface as a 500 instead of a clean 404.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resultId)) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown validation result.', correlationId: req.id });
      }
      const rec = await opts.repository.getById(resultId);
      if (!rec) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown validation result.', correlationId: req.id });
      const canRaw = req.principal!.permissions.includes('ns1.raw.read');
      return { provenance: envelope(), item: recordView(rec, canRaw) };
    },
  );

  app.get(
    '/validation/ns1/unsupported-features',
    { preHandler: requirePermission('ns1.detail.read'), schema: { tags: ['validation'], summary: 'Unsupported NS1 feature inventory', description: 'Aggregated unsupported filters and unknown metadata across recent validation results.', security: [{ bearerAuth: [] }] } },
    async (req, reply) => {
      if (!opts.repository) return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Validation history is not configured.', correlationId: req.id });
      const rows = await opts.repository.list({ limit: 500 });
      const filters = new Map<string, number>();
      const metadata = new Map<string, number>();
      for (const r of rows) {
        for (const f of (r.unsupportedFilters as string[]) ?? []) filters.set(f, (filters.get(f) ?? 0) + 1);
        const unknown = (r.unknownFields ?? {}) as { metadata?: string[] };
        for (const m of unknown.metadata ?? []) metadata.set(m, (metadata.get(m) ?? 0) + 1);
      }
      const toList = (m: Map<string, number>) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      return { provenance: envelope(), unsupportedFilters: toList(filters), unknownMetadataFields: toList(metadata) };
    },
  );
};

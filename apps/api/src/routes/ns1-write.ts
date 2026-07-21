// Guarded NS1 create-record routes — RADAR's only write to NS1. `plan` is a pure DRY-RUN (validates
// + returns the exact NS1 request without sending it); `apply` performs the audited write after the
// operator confirms. Engineer-gated (ns1.record.create). The write is refused unless every guard in
// the record-writer passes (write enabled, live+key, allow-list, protected-name denylist).
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import { Ns1WriteError, type CloneTarget, type CreateRecordInput, type Ns1RecordWriter } from '../ns1/record-writer.js';
import type { Ns1ReadClient } from '../ns1/client.js';
import type { AuditSink } from '../cloudvision/manager.js';

export interface Ns1WriteRoutesOptions {
  /** A fixed writer, or a provider that returns the current writer (so runtime key/mode changes on
   *  the Integrations page take effect without re-wiring). */
  writer: Ns1RecordWriter | (() => Ns1RecordWriter);
  /** Read client — used to fetch the SOURCE record for a clone (GET-only). */
  readClient?: Ns1ReadClient;
  /** Toggle the NS1_WRITE_ENABLED gate at runtime (persisted + audited by the manager). */
  setWriteEnabled?: (enabled: boolean, actor: { subject?: string; roles?: string[]; correlationId?: string }) => Promise<unknown>;
  audit?: AuditSink;
}

const createBody = z.object({
  zone: z.string().min(1).max(253),
  domain: z.string().min(1).max(253),
  type: z.enum(['A', 'AAAA', 'CNAME']),
  answers: z.array(z.string().min(1).max(253)).min(1).max(32),
  ttl: z.coerce.number().int().min(1).max(604800),
});
const cloneBody = z.object({
  // Either read the source from NS1 (source ref) OR supply an edited record body directly (record).
  source: z.object({ zone: z.string().min(1).max(253), domain: z.string().min(1).max(253), type: z.enum(['A', 'AAAA', 'CNAME']) }).optional(),
  record: z.record(z.string(), z.unknown()).optional(),
  target: z.object({ zone: z.string().min(1).max(253), domain: z.string().min(1).max(253), ttl: z.coerce.number().int().min(1).max(604800).optional() }),
}).refine((b) => !!b.source || !!b.record, { message: 'Provide either a source record reference or an edited record body.' });
const schema = (summary: string, description: string) => ({ tags: ['ns1'], summary, description, security: [{ bearerAuth: [] }] });

export const ns1WriteRoutes: FastifyPluginAsync<Ns1WriteRoutesOptions> = async (app, opts) => {
  const getWriter = (): Ns1RecordWriter => (typeof opts.writer === 'function' ? opts.writer() : opts.writer);
  // Capability + allow-list, so the UI can show what's writable before anyone tries.
  app.get(
    '/ns1/records/capability',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Create-record capability', 'Engineer-only. The write gate state, whether writes are actually ready (gate + live + key), and the allow-list of names that may be created. No credentials.') },
    async () => ({ writeEnabled: getWriter().writeEnabled(), writeReady: getWriter().writeReady(), allowList: getWriter().allowList() }),
  );

  // Toggle the NS1_WRITE_ENABLED gate at runtime (engineer-only, persisted + audited).
  app.post(
    '/ns1/records/write-enabled',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Toggle the write gate', 'Engineer-only. Enables/disables the guarded NS1 write path (NS1_WRITE_ENABLED). Persisted + audited.') },
    async (req, reply) => {
      if (!opts.setWriteEnabled) return reply.code(503).send({ error: 'write-gate management unavailable' });
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
      await opts.setWriteEnabled(parsed.data.enabled, { subject: req.principal?.subject, roles: req.principal?.roles, correlationId: req.id });
      return { writeEnabled: getWriter().writeEnabled(), writeReady: getWriter().writeReady(), allowList: getWriter().allowList() };
    },
  );

  // DRY-RUN: validate + build the exact NS1 request. Never writes.
  app.post(
    '/ns1/records/plan',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Plan (dry-run) a record create', 'Engineer-only. Validates against the allow-list and builds the exact NS1 PUT payload WITHOUT sending it. `allowed=false` with a reason when a guard blocks it.') },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input', detail: parsed.error.issues.map((i) => i.message) });
      return getWriter().plan(parsed.data as CreateRecordInput);
    },
  );

  // APPLY: the audited write. Refused (4xx) if a guard blocks; 502 on an upstream failure.
  app.post(
    '/ns1/records/apply',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Apply a record create (WRITE)', 'Engineer-only. Creates the record in NS1 after the guards pass. Audited; the API key is never returned. Blocked names are refused.') },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input', detail: parsed.error.issues.map((i) => i.message) });
      const input = parsed.data as CreateRecordInput;
      const actor = { actorSubject: req.principal?.subject, actorRoles: req.principal?.roles, correlationId: req.id };
      try {
        const result = await getWriter().apply(input);
        await opts.audit?.record({ ...actor, action: 'ns1.record.create', resourceType: 'ns1-record', resourceKey: `${input.domain}/${input.type}`, outcome: 'success', details: { zone: input.zone, domain: input.domain, type: input.type, ttl: input.ttl, answers: input.answers } });
        return result;
      } catch (err) {
        const blocked = err instanceof Ns1WriteError && err.blocked;
        const message = err instanceof Error ? err.message : 'create failed';
        await opts.audit?.record({ ...actor, action: 'ns1.record.create', resourceType: 'ns1-record', resourceKey: `${input.domain}/${input.type}`, outcome: blocked ? 'blocked' : 'failure', details: { zone: input.zone, domain: input.domain, type: input.type, reason: message } });
        return reply.code(blocked ? 400 : 502).send({ error: blocked ? 'blocked' : 'create failed', message });
      }
    },
  );

  // CLONE dry-run: read the SOURCE record (read client) and retarget it, without sending.
  app.post(
    '/ns1/records/clone/plan',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Plan (dry-run) a record clone', 'Engineer-only. Reads the source record and builds the cloned NS1 PUT payload for the target WITHOUT sending it. Only the target is guarded (allow-list / protected denylist).') },
    async (req, reply) => {
      const parsed = cloneBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input', detail: parsed.error.issues.map((i) => i.message) });
      const { source, record, target } = parsed.data;
      try {
        // An edited record body is used as-is; otherwise read the source from NS1.
        const src = record ?? (opts.readClient ? await opts.readClient.getRecord(source!.zone, source!.domain, source!.type, req.id) : null);
        if (src === null) return reply.code(503).send({ error: 'read client unavailable' });
        return getWriter().planClone(target as CloneTarget, src);
      } catch (err) {
        return reply.code(502).send({ error: 'source read failed', message: err instanceof Error ? err.message : 'could not read source record' });
      }
    },
  );

  // CLONE apply: read source → retarget → audited PUT.
  app.post(
    '/ns1/records/clone/apply',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Apply a record clone (WRITE)', 'Engineer-only. Clones the source record onto the guarded target in NS1. Audited; blocked targets are refused.') },
    async (req, reply) => {
      const parsed = cloneBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input', detail: parsed.error.issues.map((i) => i.message) });
      const { source, record, target } = parsed.data;
      const actor = { actorSubject: req.principal?.subject, actorRoles: req.principal?.roles, correlationId: req.id };
      const srcLabel = source ? `${source.domain}/${source.type}` : 'edited';
      let src: unknown;
      try {
        src = record ?? (opts.readClient ? await opts.readClient.getRecord(source!.zone, source!.domain, source!.type, req.id) : null);
        if (src === null) return reply.code(503).send({ error: 'read client unavailable' });
      } catch (err) {
        return reply.code(502).send({ error: 'source read failed', message: err instanceof Error ? err.message : 'could not read source record' });
      }
      try {
        const result = await getWriter().applyClone(target as CloneTarget, src);
        await opts.audit?.record({ ...actor, action: 'ns1.record.clone', resourceType: 'ns1-record', resourceKey: `${target.domain}`, outcome: 'success', details: { source: srcLabel, target: target.domain, zone: target.zone, ttl: target.ttl } });
        return result;
      } catch (err) {
        const blocked = err instanceof Ns1WriteError && err.blocked;
        const message = err instanceof Error ? err.message : 'clone failed';
        await opts.audit?.record({ ...actor, action: 'ns1.record.clone', resourceType: 'ns1-record', resourceKey: `${target.domain}`, outcome: blocked ? 'blocked' : 'failure', details: { source: srcLabel, target: target.domain, reason: message } });
        return reply.code(blocked ? 400 : 502).send({ error: blocked ? 'blocked' : 'clone failed', message });
      }
    },
  );
};

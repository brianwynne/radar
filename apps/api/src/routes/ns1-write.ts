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
  writer: Ns1RecordWriter;
  /** Read client — used to fetch the SOURCE record for a clone (GET-only). */
  readClient?: Ns1ReadClient;
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
  source: z.object({ zone: z.string().min(1).max(253), domain: z.string().min(1).max(253), type: z.enum(['A', 'AAAA', 'CNAME']) }),
  target: z.object({ zone: z.string().min(1).max(253), domain: z.string().min(1).max(253), ttl: z.coerce.number().int().min(1).max(604800).optional() }),
});
const schema = (summary: string, description: string) => ({ tags: ['ns1'], summary, description, security: [{ bearerAuth: [] }] });

export const ns1WriteRoutes: FastifyPluginAsync<Ns1WriteRoutesOptions> = async (app, opts) => {
  // Capability + allow-list, so the UI can show what's writable before anyone tries.
  app.get(
    '/ns1/records/capability',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Create-record capability', 'Engineer-only. Whether the guarded NS1 create path is enabled, and the allow-list of names that may be created. No credentials.') },
    async () => ({ writeEnabled: opts.writer.writeEnabled(), allowList: opts.writer.allowList() }),
  );

  // DRY-RUN: validate + build the exact NS1 request. Never writes.
  app.post(
    '/ns1/records/plan',
    { preHandler: requirePermission('ns1.record.create'), schema: schema('Plan (dry-run) a record create', 'Engineer-only. Validates against the allow-list and builds the exact NS1 PUT payload WITHOUT sending it. `allowed=false` with a reason when a guard blocks it.') },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input', detail: parsed.error.issues.map((i) => i.message) });
      return opts.writer.plan(parsed.data as CreateRecordInput);
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
        const result = await opts.writer.apply(input);
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
      if (!opts.readClient) return reply.code(503).send({ error: 'read client unavailable' });
      const { source, target } = parsed.data;
      try {
        const src = await opts.readClient.getRecord(source.zone, source.domain, source.type, req.id);
        return opts.writer.planClone(target as CloneTarget, src);
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
      if (!opts.readClient) return reply.code(503).send({ error: 'read client unavailable' });
      const { source, target } = parsed.data;
      const actor = { actorSubject: req.principal?.subject, actorRoles: req.principal?.roles, correlationId: req.id };
      let src: unknown;
      try {
        src = await opts.readClient.getRecord(source.zone, source.domain, source.type, req.id);
      } catch (err) {
        return reply.code(502).send({ error: 'source read failed', message: err instanceof Error ? err.message : 'could not read source record' });
      }
      try {
        const result = await opts.writer.applyClone(target as CloneTarget, src);
        await opts.audit?.record({ ...actor, action: 'ns1.record.clone', resourceType: 'ns1-record', resourceKey: `${target.domain}/${source.type}`, outcome: 'success', details: { source: `${source.domain}/${source.type}`, target: target.domain, zone: target.zone, ttl: target.ttl } });
        return result;
      } catch (err) {
        const blocked = err instanceof Ns1WriteError && err.blocked;
        const message = err instanceof Error ? err.message : 'clone failed';
        await opts.audit?.record({ ...actor, action: 'ns1.record.clone', resourceType: 'ns1-record', resourceKey: `${target.domain}/${source.type}`, outcome: blocked ? 'blocked' : 'failure', details: { source: `${source.domain}/${source.type}`, target: target.domain, reason: message } });
        return reply.code(blocked ? 400 : 502).send({ error: blocked ? 'blocked' : 'clone failed', message });
      }
    },
  );
};

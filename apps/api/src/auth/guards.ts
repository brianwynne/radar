// Reusable server-side authorisation guards (Fastify preHandlers). Frontend hiding is
// not security — every check happens here. They read only request.principal.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RadarPermission } from './permissions.js';

function unauthenticated(req: FastifyRequest, reply: FastifyReply): void {
  req.log.info({ route: req.url, correlationId: req.id }, 'unauthenticated request rejected');
  void reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication is required.', correlationId: req.id });
}

/** Reject unauthenticated callers with 401. */
export async function requireAuthentication(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.principal) unauthenticated(req, reply);
}

/** Reject callers who are unauthenticated (401) or lack the permission (403). */
export function requirePermission(permission: RadarPermission) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.principal) {
      unauthenticated(req, reply);
      return;
    }
    if (!req.principal.permissions.includes(permission)) {
      req.log.info(
        { subject: req.principal.subject, roles: req.principal.roles, route: req.url, required: permission, correlationId: req.id },
        'permission denied',
      );
      void reply.code(403).send({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.', correlationId: req.id });
    }
  };
}

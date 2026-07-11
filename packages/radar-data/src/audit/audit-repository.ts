import type { AuditEvent, AuditQuery, NewAuditEvent } from '../types.js';

/** Framework-independent persistence contract for the audit trail. */
export interface AuditRepository {
  record(input: NewAuditEvent): Promise<AuditEvent>;
  list(query?: AuditQuery): Promise<AuditEvent[]>;
}

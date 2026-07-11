// Framework-independent persistence contracts. This package depends on no HTTP or web
// framework and on no specific PostgreSQL client: it talks to any driver that satisfies
// the minimal `Queryable` below (node-pg's Pool/PoolClient and pg-mem both do). RADAR v1
// is read-only towards NS1; these tables store RADAR's own captured snapshots and audit
// trail, never a write path back to NS1.

/** Minimal query surface shared by node-pg (Pool/PoolClient) and pg-mem. */
export interface QueryResultLike<R> {
  rows: R[];
  rowCount?: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

// --- Configuration snapshots -------------------------------------------------

/** An immutable capture of an upstream configuration resource (e.g. an NS1 zone or
 *  record) exactly as retrieved, plus a canonicalised form and integrity checksums.
 *  The raw payload is preserved verbatim (ADR-0001); nothing is stored on the filesystem
 *  or in blob storage — payloads live in the row as JSONB. */
export interface NewSnapshot {
  /** Origin of the configuration, e.g. `ns1`. */
  sourceSystem: string;
  /** Kind of resource, e.g. `zone`, `record`. */
  resourceKind: string;
  /** Natural key within the source, e.g. `rte.ie` or `live.rte.ie/A`. */
  resourceKey: string;
  /** Read-only endpoint the payload came from (no credentials). */
  sourceEndpoint?: string;
  /** When the upstream resource was retrieved. */
  retrievedAt: Date;
  /** Authenticated subject that captured the snapshot (audit linkage). */
  createdBySubject?: string;
  /** Optional human label. */
  label?: string;
  /** Verbatim upstream payload. */
  rawPayload: unknown;
  /** Canonicalised payload used for comparison/explanation. */
  canonicalPayload: unknown;
  /** Checksum of the raw payload (integrity + dedupe support). */
  rawChecksum: string;
  /** Checksum of structurally-significant fields (change detection). */
  structuralChecksum?: string;
  /** Free-form, non-sensitive capture metadata. */
  metadata?: Record<string, unknown>;
}

export interface ConfigurationSnapshot extends NewSnapshot {
  id: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export interface SnapshotQuery {
  resourceKind?: string;
  resourceKey?: string;
  sourceSystem?: string;
  /** Filter by exact raw-payload checksum. */
  rawChecksum?: string;
  /** Only snapshots retrieved at or after this instant. */
  retrievedSince?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

// --- Audit events ------------------------------------------------------------

/** A security/operational audit record. `details` MUST NOT contain tokens, NS1 API
 *  keys, database credentials, or complete sensitive headers — callers are responsible
 *  for redaction before persistence. */
export interface NewAuditEvent {
  actorSubject?: string;
  actorRoles?: string[];
  authenticationMethod?: string;
  action: string;
  resourceType?: string;
  resourceKey?: string;
  outcome: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEvent extends NewAuditEvent {
  id: string;
  occurredAt: Date;
  actorRoles: string[];
  details: Record<string, unknown>;
}

export interface AuditQuery {
  actorSubject?: string;
  action?: string;
  resourceType?: string;
  resourceKey?: string;
  outcome?: string;
  correlationId?: string;
  /** Only events at or after this instant. */
  occurredAfter?: Date;
  /** Only events at or before this instant. */
  occurredBefore?: Date;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

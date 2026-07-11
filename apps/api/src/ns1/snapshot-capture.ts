// Reusable snapshot capture: preserve raw, canonicalise, checksum, and persist the
// snapshot + its audit event ATOMICALLY. Shared by the capture route and the change-
// detection service so canonicalisation and the atomic-audit guarantee are identical.
import type { ConfigurationSnapshot } from '@radar/data';
import type { Database } from '../database/repositories.js';
import type { RadarMode } from './config.js';
import { canonicalise, rawChecksum, structuralChecksum } from './snapshot.js';

export interface RecordTarget {
  zone: string;
  domain: string;
  type: string;
}

export interface CaptureOptions {
  createdBySubject?: string;
  label?: string;
  auditActorRoles?: string[];
  auditAuthenticationMethod?: string;
  auditAction?: string;
  correlationId?: string;
}

export async function captureRecordSnapshot(
  database: Database,
  target: RecordTarget,
  raw: unknown,
  mode: RadarMode,
  opts: CaptureOptions = {},
): Promise<ConfigurationSnapshot> {
  const resourceKey = `${target.zone}/${target.domain}/${target.type}`;
  const warnings = mode === 'mock' ? ['Captured in mock mode; payload is synthetic and non-production.'] : [];
  const newSnapshot = {
    sourceSystem: 'ns1',
    resourceKind: 'record',
    resourceKey,
    sourceEndpoint: `/v1/zones/${target.zone}/${target.domain}/${target.type}`,
    retrievedAt: new Date(),
    createdBySubject: opts.createdBySubject,
    label: opts.label,
    rawPayload: raw,
    canonicalPayload: canonicalise(raw),
    rawChecksum: rawChecksum(raw),
    structuralChecksum: structuralChecksum(raw),
    metadata: { mode, synthetic: mode === 'mock', warnings },
  };

  return database.transaction(async (repos) => {
    const created = await repos.snapshots.create(newSnapshot);
    await repos.audit.record({
      actorSubject: opts.createdBySubject,
      actorRoles: opts.auditActorRoles,
      authenticationMethod: opts.auditAuthenticationMethod,
      action: opts.auditAction ?? 'snapshot.create',
      resourceType: 'record',
      resourceKey,
      outcome: 'success',
      correlationId: opts.correlationId,
      details: { snapshotId: created.id, rawChecksum: created.rawChecksum, mode, synthetic: mode === 'mock' },
    });
    return created;
  });
}

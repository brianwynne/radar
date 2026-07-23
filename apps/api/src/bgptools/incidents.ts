// Pure mapping from routing-integrity assessments to incident actions. Deterministic; no I/O.
// Repeated observations of the same problem for a prefix collapse to ONE incident (keyed by
// prefix + kind); when the problem clears the incident is resolved; a stale/unknown assessment
// leaves open incidents untouched (we don't know, so we don't act). The poller applies the plan
// through the incident repository.
import type { IncidentKind, IncidentSeverity, IncidentSignal } from '@radar/data';
import type { RoutingIntegrityAssessment } from './types.js';

/** The single dominant incident kind for an assessment, or null when nothing should be open
 *  (healthy, or unknown/stale — handled separately by the planner). Precedence: withdrawn >
 *  hijack (expected origin absent) > critical visibility loss > MOAS > degraded visibility loss. */
export function primaryIncident(a: RoutingIntegrityAssessment): { kind: IncidentKind; severity: IncidentSeverity } | null {
  const s = a.signals;
  if (!s || a.state === 'healthy' || a.state === 'unknown') return null;
  if (s.prefixWithdrawn) return { kind: 'withdrawn', severity: 'critical' };
  const expectedPresent = s.observedOrigins.some((o) => o.asn === s.expectedOriginAsn);
  if (!expectedPresent) return { kind: 'hijack', severity: 'critical' };
  if (a.state === 'critical') return { kind: 'visibility_loss', severity: 'critical' };
  if (s.moas) return { kind: 'moas', severity: 'degraded' };
  return { kind: 'visibility_loss', severity: 'degraded' };
}

export interface IncidentPlan {
  /** Incidents to open or update (bump/regroup). */
  opens: IncidentSignal[];
  /** Open incidents to resolve (problem cleared or changed kind). */
  resolves: Array<{ prefix: string; kind: IncidentKind }>;
}

/** Reconcile the current assessments against the set of already-open incidents (kinds per prefix)
 *  and produce the open/resolve actions. Pure. */
export function planIncidentActions(
  assessments: RoutingIntegrityAssessment[],
  openByPrefix: Map<string, Set<IncidentKind>>,
): IncidentPlan {
  const opens: IncidentSignal[] = [];
  const resolves: Array<{ prefix: string; kind: IncidentKind }> = [];
  for (const a of assessments) {
    if (!a.prefix) continue;
    if (a.state === 'unknown') continue; // stale/unknown → don't touch open incidents
    const open = openByPrefix.get(a.prefix) ?? new Set<IncidentKind>();
    const desired = primaryIncident(a);
    if (desired) {
      opens.push({ prefix: a.prefix, kind: desired.kind, severity: desired.severity, observedAt: a.assessedAt, evidence: { reasons: a.reasons, signals: a.signals } });
      for (const k of open) if (k !== desired.kind) resolves.push({ prefix: a.prefix, kind: k }); // problem changed shape
    } else {
      for (const k of open) resolves.push({ prefix: a.prefix, kind: k }); // healthy → clear all open
    }
  }
  return { opens, resolves };
}

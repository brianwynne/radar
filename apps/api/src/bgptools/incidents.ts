// Pure mapping from routing-integrity assessments to incident actions. Deterministic; no I/O.
// A prefix can have SEVERAL concurrent problems of different kinds (e.g. a visibility loss AND a
// missing upstream) — each is its own incident, grouped by prefix + kind. Repeated observations
// collapse into one incident; when a problem clears the incident is resolved; a stale/unknown
// assessment leaves open incidents untouched (we don't know, so we don't act). The poller applies
// the plan through the incident repository.
import type { IncidentKind, IncidentSeverity, IncidentSignal } from '@radar/data';
import type { AssessmentThresholds } from './adapter.js';
import type { RoutingIntegrityAssessment } from './types.js';

/** All active incident kinds for an assessment (empty when healthy or unknown/stale). A withdrawn
 *  prefix collapses to the single 'withdrawn' incident (the other checks are moot). Thresholds are
 *  the same ones the assessment used, so incidents match the verdict exactly. */
export function incidentsFor(a: RoutingIntegrityAssessment, thresholds: AssessmentThresholds): Array<{ kind: IncidentKind; severity: IncidentSeverity }> {
  const s = a.signals;
  if (!s || a.state === 'healthy' || a.state === 'unknown') return [];
  if (s.prefixWithdrawn) return [{ kind: 'withdrawn', severity: 'critical' }];

  const out: Array<{ kind: IncidentKind; severity: IncidentSeverity }> = [];
  const expectedPresent = s.observedOrigins.some((o) => o.asn === s.expectedOriginAsn);
  if (!expectedPresent) {
    out.push({ kind: 'hijack', severity: 'critical' });
  } else {
    const r = s.prefixVisibilityRatio;
    if (r !== null && r < thresholds.visibilityCriticalRatio) out.push({ kind: 'visibility_loss', severity: 'critical' });
    else if (r !== null && r < thresholds.visibilityWarnRatio) out.push({ kind: 'visibility_loss', severity: 'degraded' });
    if (s.moas) out.push({ kind: 'moas', severity: 'degraded' });
  }
  if (s.missingUpstreams.length > 0) out.push({ kind: 'missing_upstream', severity: 'degraded' });
  if (s.newUpstreams.length > 0) out.push({ kind: 'new_upstream', severity: 'degraded' });
  return out;
}

export interface IncidentPlan {
  /** Incidents to open or update (bump/regroup). */
  opens: IncidentSignal[];
  /** Open incidents to resolve (problem cleared or changed kind). */
  resolves: Array<{ prefix: string; kind: IncidentKind }>;
}

/** Reconcile the current assessments against the set of already-open incidents (kinds per prefix)
 *  and produce the open/resolve actions. Pure. Each active problem-kind is opened; any open kind no
 *  longer active is resolved; a stale/unknown assessment leaves the prefix's incidents untouched. */
export function planIncidentActions(
  assessments: RoutingIntegrityAssessment[],
  openByPrefix: Map<string, Set<IncidentKind>>,
  thresholds: AssessmentThresholds,
): IncidentPlan {
  const opens: IncidentSignal[] = [];
  const resolves: Array<{ prefix: string; kind: IncidentKind }> = [];
  for (const a of assessments) {
    if (!a.prefix) continue;
    if (a.state === 'unknown') continue; // stale/unknown → don't touch open incidents
    const open = openByPrefix.get(a.prefix) ?? new Set<IncidentKind>();
    const desired = incidentsFor(a, thresholds);
    const desiredKinds = new Set(desired.map((d) => d.kind));
    for (const d of desired) {
      opens.push({ prefix: a.prefix, kind: d.kind, severity: d.severity, observedAt: a.assessedAt, evidence: { reasons: a.reasons, signals: a.signals } });
    }
    for (const k of open) if (!desiredKinds.has(k)) resolves.push({ prefix: a.prefix, kind: k }); // no longer active
  }
  return { opens, resolves };
}

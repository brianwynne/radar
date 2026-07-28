// Stream Assurance service: runs a profile's endpoints through the SSRF-guarded probe + engine
// classification and persists a bounded run snapshot (observations + findings; no media, no keys).
// Manual runs are audited by the caller. This is the connector/orchestration layer.
import { randomUUID } from 'node:crypto';
import { streamAssurance as sa } from '@radar/engine';
import type { NewStreamAssuranceRun, StreamAssuranceRepository, StreamAssuranceRunRow } from '@radar/data';
import { observeAndClassify, type EndpointConfig } from './observe.js';
import { observeManifests, type ManifestSources } from './manifests.js';
import type { SsrfPolicy } from './ssrf.js';

/** Stable alert identity across runs — the same finding class on the same endpoint. */
const alertId = (profileId: string, f: sa.Finding): string => `${profileId}:${f.endpointId}:${f.ruleId}:${f.classification}`;

export interface StreamProfileConfig {
  endpoints: EndpointConfig[];
  authoritativeKid?: string | null;
  /** Optional DASH/HLS manifest URLs; validated + cross-protocol compared via the reference endpoint. */
  manifests?: ManifestSources;
  tags?: string[];
}

export interface StreamAssuranceServiceDeps {
  now?: () => number;
  genId?: () => string;
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export class ProfileNotFoundError extends Error {}

export class StreamAssuranceService {
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(
    private readonly repo: StreamAssuranceRepository,
    private readonly policy: SsrfPolicy,
    deps: StreamAssuranceServiceDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.genId = deps.genId ?? (() => randomUUID());
  }

  /** Run one profile now: probe every endpoint, classify, persist and return the run snapshot. */
  async run(profileId: string, mode = 'normal'): Promise<StreamAssuranceRunRow> {
    const profile = await this.repo.getProfile(profileId);
    if (!profile) throw new ProfileNotFoundError(`stream profile '${profileId}' not found`);
    const config = (profile.config ?? {}) as StreamProfileConfig;
    const startedAt = new Date(this.now());

    const endpoints = config.endpoints ?? [];
    const { results, findings } = await observeAndClassify(endpoints, this.policy, {
      authoritativeKid: config.authoritativeKid ?? null,
      nowMs: this.now(),
    });

    // Manifest validation + DASH↔HLS cross-protocol, fetched via the reference endpoint (or the
    // first), attributed to that endpoint. Bounded; skipped when no manifest URLs are configured.
    if (config.manifests && endpoints.length > 0) {
      const ref = endpoints.find((e) => e.role === 'reference') ?? endpoints[0];
      const specs = await observeManifests(config.manifests, {
        connectHost: ref.connectHost, connectPort: ref.connectPort, hostHeader: ref.hostHeader, sni: ref.sni,
        managedInternal: ref.managedInternal, timeoutMs: ref.timeoutMs, maxBytes: ref.maxBytes,
      }, this.policy, this.now());
      for (const s of specs) findings.push(sa.withEndpoint(s, ref.endpointId, ref.provider, 'packager'));
    }

    // Bounded observations — metadata + evidence only, never response bodies.
    const observations = results.map((r) => ({ ...r.observation, error: r.error ?? null }));
    const hadError = results.some((r) => r.error);
    const status = findings.some((f) => f.severity === 'critical' || f.severity === 'error') ? 'findings' : hadError ? 'error' : 'ok';

    const run: NewStreamAssuranceRun = {
      id: this.genId(), profileId, startedAt, finishedAt: new Date(this.now()),
      mode, status, observations, findings, findingCount: findings.length,
    };
    await this.repo.insertRun(run);
    await this.reconcileAlerts(profileId, findings, new Date(this.now()));
    return { ...run } as StreamAssuranceRunRow;
  }

  /** Advance the durable alert lifecycle from a run's findings: findings present in this run are
   *  promoted (observed → pending → active), and previously-open alerts absent from this run move
   *  toward resolved. Critical rules activate faster but still need ≥2 occurrences (no single-shot). */
  async reconcileAlerts(profileId: string, findings: sa.Finding[], now: Date): Promise<void> {
    const existing = await this.repo.listAlertsByProfile(profileId);
    const byId = new Map(existing.map((a) => [a.id, a]));
    const present = new Set<string>();

    for (const f of findings) {
      const id = alertId(profileId, f);
      present.add(id);
      const cur = byId.get(id);
      const life = cur
        ? { state: cur.state as sa.AlertState, consecutivePresent: cur.consecutivePresent, consecutiveAbsent: cur.consecutiveAbsent }
        : sa.INITIAL_LIFECYCLE;
      const next = sa.nextAlertState(life, true, { activateAfter: f.severity === 'critical' ? 2 : 3 });
      await this.repo.upsertAlert({
        id, profileId, endpointId: f.endpointId, ruleId: f.ruleId, classification: f.classification, severity: f.severity,
        state: next.state, consecutivePresent: next.consecutivePresent, consecutiveAbsent: next.consecutiveAbsent,
        occurrences: (cur?.occurrences ?? 0) + 1, firstObserved: cur?.firstObserved ?? now, lastObserved: now,
        explanation: f.explanation, remediation: f.remediation, evidence: f.evidence, updatedAt: now,
      });
    }

    for (const a of existing) {
      if (present.has(a.id) || a.state === 'resolved') continue;
      const next = sa.nextAlertState({ state: a.state as sa.AlertState, consecutivePresent: a.consecutivePresent, consecutiveAbsent: a.consecutiveAbsent }, false);
      if (next.state === a.state && next.consecutiveAbsent === a.consecutiveAbsent) continue;
      await this.repo.upsertAlert({
        id: a.id, profileId, endpointId: a.endpointId, ruleId: a.ruleId, classification: a.classification, severity: a.severity,
        state: next.state, consecutivePresent: next.consecutivePresent, consecutiveAbsent: next.consecutiveAbsent,
        occurrences: a.occurrences, firstObserved: a.firstObserved, lastObserved: a.lastObserved,
        explanation: a.explanation, remediation: a.remediation, evidence: a.evidence, updatedAt: now,
      });
    }
  }
}

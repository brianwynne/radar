// Stream Assurance service: runs a profile's endpoints through the SSRF-guarded probe + engine
// classification and persists a bounded run snapshot (observations + findings; no media, no keys).
// Manual runs are audited by the caller. This is the connector/orchestration layer.
import { randomUUID } from 'node:crypto';
import type { NewStreamAssuranceRun, StreamAssuranceRepository, StreamAssuranceRunRow } from '@radar/data';
import { observeAndClassify, type EndpointConfig } from './observe.js';
import type { SsrfPolicy } from './ssrf.js';

export interface StreamProfileConfig {
  endpoints: EndpointConfig[];
  authoritativeKid?: string | null;
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

    const { results, findings } = await observeAndClassify(config.endpoints ?? [], this.policy, {
      authoritativeKid: config.authoritativeKid ?? null,
      nowMs: this.now(),
    });

    // Bounded observations — metadata + evidence only, never response bodies.
    const observations = results.map((r) => ({ ...r.observation, error: r.error ?? null }));
    const hadError = results.some((r) => r.error);
    const status = findings.some((f) => f.severity === 'critical' || f.severity === 'error') ? 'findings' : hadError ? 'error' : 'ok';

    const run: NewStreamAssuranceRun = {
      id: this.genId(), profileId, startedAt, finishedAt: new Date(this.now()),
      mode, status, observations, findings, findingCount: findings.length,
    };
    await this.repo.insertRun(run);
    return { ...run } as StreamAssuranceRunRow;
  }
}

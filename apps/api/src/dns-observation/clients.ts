// DNS observation clients: disabled (placeholder), mock (deterministic synthetic), and
// resolver (real read-only UDP DNS via an injectable transport). All are read-only and
// perform a SINGLE query per observation — no aggressive probing.
import type {
  DnsObservationClient, DnsObservationScenario, DnsTransport, ObservedAnswer, RawObservation,
} from './types.js';

/** Disabled: returns a placeholder RawObservation (not a real observation). */
export class DisabledDnsObservationClient implements DnsObservationClient {
  readonly mode = 'disabled' as const;
  constructor(private readonly now: () => number = () => Date.now()) {}
  async observe(scenario: DnsObservationScenario): Promise<RawObservation> {
    return { ispId: scenario.ispId, responseCode: 'NOERROR', answers: [], ecsRequested: false, observedAt: new Date(this.now()), warnings: [], disabled: true };
  }
}

export interface MockScenarioOverride {
  answers?: ObservedAnswer[];
  responseCode?: RawObservation['responseCode'];
  ecsHonoured?: boolean;
  ttl?: number;
  latencyMs?: number;
}

export interface MockDnsObservationOptions {
  now?: () => number;
  /** Per-ISP deterministic overrides. */
  overrides?: Record<string, MockScenarioOverride>;
}

/** Deterministic, clearly-synthetic observations. Default answer is a single Réalta IP that
 *  matches the mock NS1 record's eligible set (→ a `match`), with per-ISP overrides for the
 *  mismatch / NXDOMAIN / ECS-not-honoured / unavailable scenarios. */
export class MockDnsObservationClient implements DnsObservationClient {
  readonly mode = 'mock' as const;
  private readonly now: () => number;
  private readonly overrides: Record<string, MockScenarioOverride>;

  constructor(opts: MockDnsObservationOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.overrides = opts.overrides ?? {};
  }

  async observe(scenario: DnsObservationScenario): Promise<RawObservation> {
    const o = this.overrides[scenario.ispId] ?? {};
    const responseCode = o.responseCode ?? 'NOERROR';
    const ecsRequested = scenario.ecsSubnet !== undefined;
    const ecsHonoured = ecsRequested ? o.ecsHonoured ?? true : false;
    // Default reflects a weighted_shuffle record returning the full eligible set (reordered);
    // overrides model subset selection, unexpected/missing answers, NXDOMAIN, etc.
    const answers = o.answers ?? (responseCode === 'NOERROR' ? [{ type: 'A' as const, address: '192.0.2.10' }, { type: 'A' as const, address: '192.0.2.20' }] : []);
    const warnings: string[] = [];
    if (scenario.resolvers[0]?.startsWith('192.0.2.') || scenario.resolvers[0]?.startsWith('203.0.113.')) {
      warnings.push('MOCK / SYNTHETIC observation — placeholder resolver, not production telemetry.');
    }
    return {
      ispId: scenario.ispId,
      resolverIp: scenario.resolvers[0],
      responseCode,
      answers,
      ttl: responseCode === 'NOERROR' ? o.ttl ?? 30 : undefined,
      ecsRequested,
      ecsPrefix: scenario.ecsSubnet,
      ecsHonoured: responseCode === 'NOERROR' ? ecsHonoured : undefined,
      latencyMs: o.latencyMs ?? 12,
      observedAt: new Date(this.now()),
      warnings,
    };
  }
}

export interface ResolverDnsObservationOptions {
  transport: DnsTransport;
  timeoutMs: number;
  now?: () => number;
}

/** Real read-only resolver observation over an injectable transport. Queries the first
 *  reachable configured resolver; a timeout/network failure yields an unavailable
 *  observation (never throws out). Per-observation single query. */
export class ResolverDnsObservationClient implements DnsObservationClient {
  readonly mode = 'resolver' as const;
  private readonly now: () => number;

  constructor(private readonly opts: ResolverDnsObservationOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async observe(scenario: DnsObservationScenario): Promise<RawObservation> {
    const ecsRequested = scenario.ecsSubnet !== undefined;
    const qname = scenario.domain;
    const started = this.now();
    let lastError: unknown;

    for (const resolverIp of scenario.resolvers) {
      try {
        const result = await this.opts.transport.query({ resolverIp, qname, qtype: scenario.recordType, ecsSubnet: scenario.ecsSubnet, timeoutMs: this.opts.timeoutMs });
        return {
          ispId: scenario.ispId,
          resolverIp,
          responseCode: result.responseCode,
          answers: result.answers,
          ttl: result.ttl,
          ecsRequested,
          ecsPrefix: scenario.ecsSubnet,
          // Only claim ECS honoured when the response actually confirms a scope.
          ecsHonoured: result.responseCode === 'NOERROR' ? result.ecsHonoured : undefined,
          latencyMs: Math.max(0, this.now() - started),
          observedAt: new Date(this.now()),
          warnings: ecsRequested && result.responseCode === 'NOERROR' && !result.ecsHonoured ? ['ECS requested but the response did not confirm it was honoured.'] : [],
        };
      } catch (err) {
        lastError = err;
        // try the next configured resolver
      }
    }

    const isTimeout = lastError instanceof Error && /timed out/i.test(lastError.message);
    return {
      ispId: scenario.ispId,
      resolverIp: scenario.resolvers[0],
      responseCode: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      answers: [],
      ecsRequested,
      ecsPrefix: scenario.ecsSubnet,
      latencyMs: Math.max(0, this.now() - started),
      observedAt: new Date(this.now()),
      warnings: ['No resolver responded.'],
    };
  }
}

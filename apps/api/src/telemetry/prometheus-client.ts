// Read-only Prometheus telemetry adapter. GET instant-queries only, over a bounded timeout
// with bounded retry-with-jitter for transient failures. The query is built ONLY from the
// central RADAR path mapping (server-side) — never from user input. Authentication is
// generic (optional bearer/basic from a mounted secret) and NEVER logged or returned. A
// per-path source failure yields an `unavailable` sample (never an invented value), so the
// API still lists every configured path.
import { z } from 'zod';
import { buildSample } from './sample.js';
import { TelemetryError } from './errors.js';
import type { PrometheusAuth } from './config.js';
import type {
  NetworkPathSample, NetworkPathTelemetryClient, PathMapping, PathObservation, TelemetryDirection,
} from './types.js';

export interface PrometheusClientOptions {
  baseUrl: string;
  queryTemplate: string;
  auth: PrometheusAuth;
  timeoutMs: number;
  maxRetries: number;
  mappings: PathMapping[];
  staleAfterSeconds: number;
  now?: () => number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Prometheus instant-query wire shape (docs/architecture/network-telemetry.md). */
const InstantQueryShape = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.string(),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()).optional(),
        value: z.tuple([z.number(), z.string()]),
      }),
    ),
  }),
});

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PrometheusNetworkPathTelemetryClient implements NetworkPathTelemetryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: PrometheusClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  private authHeader(): Record<string, string> {
    const a = this.opts.auth;
    if (a.kind === 'bearer' && a.bearerToken) return { Authorization: `Bearer ${a.bearerToken}` };
    if (a.kind === 'basic' && a.basicAuth) return { Authorization: `Basic ${Buffer.from(a.basicAuth).toString('base64')}` };
    return {};
  }

  /** Substitute the RADAR-owned placeholders only. */
  private buildQuery(mapping: PathMapping, direction: TelemetryDirection): string {
    return this.opts.queryTemplate
      .replaceAll('$INTERFACE', mapping.interfaceIdentity)
      .replaceAll('$DIRECTION', direction === 'inbound' ? 'in' : 'out');
  }

  private backoffMs(attempt: number): number {
    return Math.round((2 ** (attempt - 1)) * 100 * (1 + this.random()));
  }

  /** One instant query → { rateBps, atMs } or null when the series has no data. Throws
   *  TelemetryError on a hard/exhausted failure. */
  private async queryInstant(query: string, correlationId?: string): Promise<{ rateBps: number; atMs: number } | null> {
    const url = `${this.opts.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'radar/1.0', ...this.authHeader() };
    if (correlationId) headers['X-Correlation-ID'] = correlationId;

    let lastTransient: TelemetryError | undefined;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt));
      try {
        const response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.opts.timeoutMs) });
        if (!response.ok) {
          const err = TelemetryError.fromStatus(response.status);
          if (err.transient) { lastTransient = err; continue; }
          throw err;
        }
        let json: unknown;
        try {
          json = await response.json();
        } catch (cause) {
          throw new TelemetryError('TELEMETRY_INVALID_RESPONSE', undefined, { cause });
        }
        const parsed = InstantQueryShape.safeParse(json);
        if (!parsed.success) throw new TelemetryError('TELEMETRY_INVALID_RESPONSE');
        const first = parsed.data.data.result[0];
        if (!first) return null; // no series → no data for this path/direction
        const rateBps = Number(first.value[1]);
        if (!Number.isFinite(rateBps)) throw new TelemetryError('TELEMETRY_INVALID_RESPONSE');
        return { rateBps, atMs: first.value[0] * 1000 };
      } catch (err) {
        if (err instanceof TelemetryError) {
          if (err.transient) { lastTransient = err; continue; }
          throw err;
        }
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        lastTransient = new TelemetryError(isTimeout ? 'TELEMETRY_UPSTREAM_TIMEOUT' : 'TELEMETRY_UPSTREAM_UNAVAILABLE', undefined, { transient: true, cause: err });
      }
    }
    throw lastTransient ?? new TelemetryError('TELEMETRY_UPSTREAM_UNAVAILABLE');
  }

  private async observe(mapping: PathMapping, correlationId?: string): Promise<PathObservation | null> {
    const hasDirection = this.opts.queryTemplate.includes('$DIRECTION');
    const warnings: string[] = [];
    // Primary direction is required; the opposite is best-effort (only if the template
    // supports a direction placeholder).
    const primaryDir = mapping.direction;
    const oppositeDir: TelemetryDirection = primaryDir === 'outbound' ? 'inbound' : 'outbound';

    let primary: { rateBps: number; atMs: number } | null;
    try {
      primary = await this.queryInstant(this.buildQuery(mapping, primaryDir), correlationId);
    } catch {
      // Hard source failure for this path → unavailable (safe, no detail).
      return null;
    }
    if (primary === null) return null; // no data → unavailable

    let opposite: { rateBps: number; atMs: number } | null = null;
    if (hasDirection) {
      try {
        opposite = await this.queryInstant(this.buildQuery(mapping, oppositeDir), correlationId);
      } catch {
        warnings.push(`${oppositeDir} series unavailable.`);
      }
      if (opposite === null && warnings.length === 0) warnings.push(`${oppositeDir} series has no data.`);
    } else {
      warnings.push('Query template has no direction placeholder; only the primary direction is reported.');
    }

    const outboundBps = primaryDir === 'outbound' ? primary.rateBps : opposite?.rateBps ?? null;
    const inboundBps = primaryDir === 'inbound' ? primary.rateBps : opposite?.rateBps ?? null;
    return { inboundBps, outboundBps, observedAt: new Date(primary.atMs), warnings };
  }

  private async sample(mapping: PathMapping, correlationId?: string): Promise<NetworkPathSample> {
    const observation = await this.observe(mapping, correlationId);
    return buildSample(mapping, observation, { now: this.now(), staleAfterSeconds: this.opts.staleAfterSeconds, source: 'prometheus', synthetic: false });
  }

  async getNetworkPaths(correlationId?: string): Promise<NetworkPathSample[]> {
    return Promise.all(this.opts.mappings.map((m) => this.sample(m, correlationId)));
  }

  async getNetworkPath(pathId: string, correlationId?: string): Promise<NetworkPathSample | null> {
    const mapping = this.opts.mappings.find((m) => m.id === pathId);
    return mapping ? this.sample(mapping, correlationId) : null;
  }
}

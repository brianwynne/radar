// Shared read-only Prometheus instant-query mechanics: GET-only, bounded timeout, bounded
// retry-with-jitter for transient failures, instant-vector validation, and safe error
// mapping. Generic auth (bearer/basic) is applied from configuration; the token is NEVER
// logged or returned. No user-supplied query reaches here — callers build queries from
// RADAR-owned templates only.
import { z } from 'zod';
import { TelemetryError } from './errors.js';
import type { PrometheusAuth } from './config.js';

export interface PrometheusHttpOptions {
  baseUrl: string;
  auth: PrometheusAuth;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const InstantQueryShape = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.string(),
    result: z.array(z.object({ metric: z.record(z.string(), z.string()).optional(), value: z.tuple([z.number(), z.string()]) })),
  }),
});

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PrometheusHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: PrometheusHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  private authHeader(): Record<string, string> {
    const a = this.opts.auth;
    if (a.kind === 'bearer' && a.bearerToken) return { Authorization: `Bearer ${a.bearerToken}` };
    if (a.kind === 'basic' && a.basicAuth) return { Authorization: `Basic ${Buffer.from(a.basicAuth).toString('base64')}` };
    return {};
  }

  private backoffMs(attempt: number): number {
    return Math.round(2 ** (attempt - 1) * 100 * (1 + this.random()));
  }

  /** One instant query → { value, atMs } or null when the series has no data. Throws
   *  TelemetryError on a hard/exhausted failure. */
  async queryInstant(query: string, correlationId?: string): Promise<{ value: number; atMs: number } | null> {
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
        if (!first) return null;
        const value = Number(first.value[1]);
        if (!Number.isFinite(value)) throw new TelemetryError('TELEMETRY_INVALID_RESPONSE');
        return { value, atMs: first.value[0] * 1000 };
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
}

// Live NS1 read client (docs/ns1/developer-guide.md §22-24). GET-only over HTTPS with a
// redacted X-NSONE-Key, a short explicit timeout, path-component encoding, and bounded
// retry-with-jitter for transient GET failures only. There is no method that issues a
// non-GET request or accepts an arbitrary URL. The API key is never logged.
import type { z } from 'zod';
import type { ActivityQuery, Ns1ReadClient } from './client.js';
import { Ns1Error } from './errors.js';
import { Ns1ActivityShape, Ns1RecordShape, Ns1ZoneShape, Ns1ZonesListShape, validateShape } from './wire.js';

export interface HttpNs1ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  userAgent?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for jitter (tests pass a constant). */
  random?: () => number;
}

const enc = encodeURIComponent;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpNs1ReadClient implements Ns1ReadClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly userAgent: string;

  constructor(private readonly opts: HttpNs1ClientOptions) {
    if (!/^https:\/\//i.test(opts.baseUrl)) {
      throw new Error('HttpNs1ReadClient: baseUrl must use HTTPS.');
    }
    // Bind (do not capture the whole global object as `this`).
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.userAgent = opts.userAgent ?? 'radar/1.0';
  }

  listZones(correlationId?: string): Promise<unknown> {
    return this.getJson('/zones', Ns1ZonesListShape, correlationId);
  }

  getZone(zone: string, correlationId?: string): Promise<unknown> {
    return this.getJson(`/zones/${enc(zone)}`, Ns1ZoneShape, correlationId);
  }

  getRecord(zone: string, domain: string, type: string, correlationId?: string): Promise<unknown> {
    return this.getJson(`/zones/${enc(zone)}/${enc(domain)}/${enc(type)}`, Ns1RecordShape, correlationId);
  }

  getActivity(query: ActivityQuery = {}, correlationId?: string): Promise<unknown> {
    // Build the query string only from an allow-list — never pass through arbitrary input.
    const search = new URLSearchParams();
    if (query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0) {
      search.set('limit', String(query.limit));
    }
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return this.getJson(`/account/activity${suffix}`, Ns1ActivityShape, correlationId);
  }

  private async getJson(path: string, shape: z.ZodType<unknown>, correlationId?: string): Promise<unknown> {
    const url = `${this.opts.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-NSONE-Key': this.opts.apiKey, // redacted from all logs (see app logger redact list)
      'User-Agent': this.userAgent,
    };
    if (correlationId) headers['X-Correlation-ID'] = correlationId;

    let lastTransient: Ns1Error | undefined;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt));
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (!response.ok) {
          const err = Ns1Error.fromStatus(response.status, correlationId);
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        let json: unknown;
        try {
          json = await response.json();
        } catch (cause) {
          throw new Ns1Error('NS1_INVALID_RESPONSE', undefined, { correlationId, cause });
        }
        if (validateShape(shape, json) === null) {
          throw new Ns1Error('NS1_INVALID_RESPONSE', undefined, { correlationId });
        }
        return json; // raw NS1 JSON, unchanged
      } catch (err) {
        if (err instanceof Ns1Error) {
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        // AbortSignal.timeout aborts with a TimeoutError; other network errors are transient.
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        lastTransient = new Ns1Error(
          isTimeout ? 'NS1_UPSTREAM_TIMEOUT' : 'NS1_UPSTREAM_UNAVAILABLE',
          undefined,
          { correlationId, transient: true, cause: err },
        );
      }
    }
    // Retries exhausted on a transient failure.
    throw lastTransient ?? new Ns1Error('NS1_UPSTREAM_UNAVAILABLE', undefined, { correlationId });
  }

  /** Bounded exponential backoff with full jitter (guide §20.3). */
  private backoffMs(attempt: number): number {
    const base = Math.min(1000, 100 * 2 ** (attempt - 1));
    return Math.round(base * this.random());
  }
}

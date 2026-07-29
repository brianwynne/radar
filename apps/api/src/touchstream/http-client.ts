// Live Touchstream client. GET-only, read-only, credentials never logged.
//
// Auth is BOTH headers together — `X-TS-ID: <app id>` and `Authorization: Bearer <token>`. Verified
// live: either alone returns 403, so a 401/403 is reported as an auth fault with that explanation
// rather than as a permissions puzzle. Errors never carry the request URL or headers, so no
// credential can reach a log line. Uses global fetch + AbortSignal.timeout, matching the
// CloudVision client's idiom (no new dependency).
import type { ZodType } from 'zod';
import { TouchstreamError, type TouchstreamClient, type TouchstreamStatsQuery } from './client.js';
import type { TouchstreamConfig } from './config.js';
import {
  tsErrorListSchema,
  tsLocationGroupListSchema,
  tsStatListSchema,
  tsStreamFullListSchema,
  type TsError,
  type TsLocationGroup,
  type TsStat,
  type TsStreamFull,
} from './wire.js';

interface Logger {
  debug: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface HttpTouchstreamClientDeps {
  config: TouchstreamConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Injectable so tests do not actually sleep between retries. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class HttpTouchstreamReadClient implements TouchstreamClient {
  private readonly config: TouchstreamConfig;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(deps: HttpTouchstreamClientDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = deps.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get base(): string {
    const endpoint = this.config.endpoint;
    if (!endpoint) throw new TouchstreamError('Touchstream endpoint is not configured.', 'TOUCHSTREAM_UNAVAILABLE');
    return endpoint;
  }

  private init(): RequestInit {
    return {
      method: 'GET',
      headers: {
        // Both are required together — see the module comment.
        'X-TS-ID': this.config.appId ?? '',
        authorization: `Bearer ${this.config.token ?? ''}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
    };
  }

  /** One read, with bounded backoff for transient failures only. */
  private async get(path: string, label: string): Promise<unknown> {
    const attempts = Math.max(1, this.config.retryAttempts + 1);
    let lastError: TouchstreamError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.sleepImpl(Math.min(2000, 250 * 2 ** (attempt - 2)));
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, this.init());
        if (res.status === 401 || res.status === 403) {
          throw new TouchstreamError(
            'Touchstream rejected the credentials. It requires BOTH the X-TS-ID app id and the bearer token — either alone is refused.',
            'TOUCHSTREAM_AUTH',
            res.status,
          );
        }
        if (!res.ok) {
          throw new TouchstreamError(`Touchstream ${label} failed with HTTP ${res.status}.`, 'TOUCHSTREAM_UNAVAILABLE', res.status);
        }
        return parseBody(await res.text(), label);
      } catch (err) {
        // An auth rejection or a malformed payload will not improve on retry.
        if (err instanceof TouchstreamError) {
          if (err.code === 'TOUCHSTREAM_AUTH' || err.code === 'TOUCHSTREAM_INVALID_RESPONSE') throw err;
          lastError = err;
        } else {
          const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          lastError = new TouchstreamError(
            `Touchstream ${label} ${timedOut ? 'timed out' : 'was unreachable'}.`,
            timedOut ? 'TOUCHSTREAM_TIMEOUT' : 'TOUCHSTREAM_UNAVAILABLE',
          );
        }
        this.logger?.debug({ label, attempt, code: lastError.code }, 'touchstream: read failed');
      }
    }
    throw lastError ?? new TouchstreamError(`Touchstream ${label} was unreachable.`, 'TOUCHSTREAM_UNAVAILABLE');
  }

  async fetchStreams(): Promise<TsStreamFull[]> {
    // NOTE: `?stream_key=` is documented on this endpoint but IGNORED live — it returns every
    // monitor regardless, so there is no point sending it. Callers filter client-side.
    return validate(tsStreamFullListSchema, await this.get('/api/stream_status_full/', 'stream status'), 'stream status');
  }

  async fetchLocationGroups(): Promise<(TsLocationGroup | null)[]> {
    return validate(tsLocationGroupListSchema, await this.get('/api/location_detail/', 'location detail'), 'location detail');
  }

  async fetchStats(query: TouchstreamStatsQuery): Promise<TsStat[]> {
    const path = `/api/stream_stats/${query.environment}/${Math.floor(query.startEpochSeconds)}/${Math.floor(query.endEpochSeconds)}/`;
    return validate(tsStatListSchema, await this.get(path, 'stream stats'), 'stream stats');
  }

  async fetchErrors(query: TouchstreamStatsQuery): Promise<TsError[]> {
    const path = `/api/error_log/${query.environment}/${Math.floor(query.startEpochSeconds)}/${Math.floor(query.endEpochSeconds)}/`;
    return validate(tsErrorListSchema, await this.get(path, 'error log'), 'error log');
  }
}

/** Touchstream sometimes returns a JSON *string* containing the payload (observed on stream_stats),
 *  so one unwrap is attempted before giving up. An empty body is an empty list, not an error. */
export function parseBody(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new TouchstreamError(`Touchstream ${label} returned a non-JSON body.`, 'TOUCHSTREAM_INVALID_RESPONSE');
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new TouchstreamError(`Touchstream ${label} returned an unparseable JSON string.`, 'TOUCHSTREAM_INVALID_RESPONSE');
    }
  }
  return value;
}

function validate<T>(schema: ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new TouchstreamError(`Touchstream ${label} did not match the expected shape: ${detail}`, 'TOUCHSTREAM_INVALID_RESPONSE');
  }
  return parsed.data;
}

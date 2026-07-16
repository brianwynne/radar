// Live, READ-ONLY Fastly real-time analytics client. Long-polls a single service's per-second
// channel on rt.fastly.com with a `Fastly-Key` token that is NEVER logged. There is NO method
// that issues a non-GET request. Fastly wire shapes are mapped to RADAR's canonical model here
// and never escape this module.
//
// API used (read; requires a token with the `global:read` scope):
//   GET /v1/channel/{service_id}/ts/{timestamp}   — blocks ~AggregateDelay seconds, then returns
//     the per-second buckets recorded since {timestamp}. Start with {timestamp}=0 for the latest
//     bucket + the next cursor. Docs: https://developer.fastly.com/reference/api/metrics-stats/realtime/
import { FastlyError } from './errors.js';
import type { FastlyRealtimeBatch, FastlyRealtimeClient, FastlyRealtimeSample } from './types.js';

export interface HttpFastlyRealtimeClientOptions {
  /** Base URL of the real-time host (default https://rt.fastly.com). */
  realtimeApiBase: string;
  token: string;
  /** Per-request timeout; must exceed the server aggregate delay (~5-9s) so a long-poll can return. */
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

const enc = encodeURIComponent;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const has = (o: Record<string, unknown>, k: string): boolean => typeof o[k] === 'number';

export class HttpFastlyRealtimeClient implements FastlyRealtimeClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpFastlyRealtimeClientOptions) {
    this.base = opts.realtimeApiBase.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(this.base)) throw new Error('HttpFastlyRealtimeClient: realtimeApiBase must be an http(s) URL.');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async pollChannel(
    serviceId: string,
    sinceTimestamp: number,
    opts?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<FastlyRealtimeBatch> {
    const cursor = Math.max(0, Math.floor(sinceTimestamp || 0));
    const url = `${this.base}/v1/channel/${enc(serviceId)}/ts/${cursor}`;

    // Combine the caller's abort signal (a clean stop) with a per-request timeout. On a clean stop
    // the AbortError is re-thrown for the streamer to swallow; a timeout is a transient error.
    const timeout = AbortSignal.timeout(this.opts.requestTimeoutMs);
    const ctrl = new AbortController();
    const onTimeout = (): void => ctrl.abort(timeout.reason);
    const onExternal = (): void => ctrl.abort(opts?.signal?.reason);
    timeout.addEventListener('abort', onTimeout, { once: true });
    opts?.signal?.addEventListener('abort', onExternal, { once: true });

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: this.headers(opts?.correlationId), signal: ctrl.signal });
    } catch (err) {
      if (opts?.signal?.aborted) throw err; // clean stop — let the streamer recognise the AbortError
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new FastlyError(isTimeout ? 'FASTLY_UPSTREAM_TIMEOUT' : 'FASTLY_UPSTREAM_UNAVAILABLE', undefined, {
        correlationId: opts?.correlationId, transient: true, cause: err,
      });
    } finally {
      timeout.removeEventListener('abort', onTimeout);
      opts?.signal?.removeEventListener('abort', onExternal);
    }

    if (!res.ok) throw FastlyError.fromStatus(res.status, opts?.correlationId);
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new FastlyError('FASTLY_INVALID_RESPONSE', undefined, { correlationId: opts?.correlationId, cause });
    }
    return parseBatch(body, cursor, opts?.correlationId);
  }

  private headers(correlationId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'Fastly-Key': this.opts.token, // redacted from all logs
      'User-Agent': 'radar/1.0',
    };
    if (correlationId) h['X-Correlation-ID'] = correlationId;
    return h;
  }
}

// ---- Wire → canonical mapper (pure) ---------------------------------------------------------

/** Map a real-time channel response to a canonical batch. Field names follow Fastly's Go-style
 *  capitalisation (`Timestamp`, `Data`, `AggregateDelay`); the lowercase variants are accepted
 *  defensively. Unknown / missing counters become 0 for that second. */
export function parseBatch(body: unknown, cursor: number, correlationId?: string): FastlyRealtimeBatch {
  if (!isObj(body)) throw new FastlyError('FASTLY_INVALID_RESPONSE', 'Fastly real-time response was not an object.', { correlationId });
  const nextTimestamp = num(body.Timestamp ?? body.timestamp) || cursor;
  const aggregateDelaySeconds = num(body.AggregateDelay ?? body.aggregate_delay);
  const rawData = Array.isArray(body.Data) ? body.Data : Array.isArray(body.data) ? body.data : [];
  const samples = rawData
    .filter(isObj)
    .map(toSample)
    .filter((s): s is FastlyRealtimeSample => s !== null)
    .sort((a, b) => a.second - b.second);
  return { samples, nextTimestamp, aggregateDelaySeconds };
}

function toSample(entry: Record<string, unknown>): FastlyRealtimeSample | null {
  const second = num(entry.recorded ?? entry.Recorded);
  if (second <= 0) return null;
  const a = isObj(entry.aggregated) ? entry.aggregated : isObj(entry.Aggregated) ? entry.Aggregated : {};
  return {
    second,
    at: new Date(second * 1000).toISOString(),
    requests: num(a.requests),
    hits: num(a.hits),
    miss: num(a.miss),
    errors: num(a.errors),
    bandwidthBytes: bandwidthOf(a),
    status2xx: num(a.status_2xx),
    status3xx: num(a.status_3xx),
    status4xx: num(a.status_4xx),
    status5xx: num(a.status_5xx),
    statusCodes: specificStatusCodes(a),
  };
}

/** Pull the individual `status_<code>` counters (e.g. status_200, status_404) into a { code: count }
 *  map, keeping only real 3-digit codes with traffic. The class aggregates (status_2xx) are the
 *  letter-suffixed keys and are deliberately excluded by the digit check. */
function specificStatusCodes(a: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) {
    const m = /^status_(\d{3})$/.exec(k);
    if (m && typeof v === 'number' && v > 0) out[m[1]] = v;
  }
  return out;
}

/** Real-time reports bytes as body + header size; older/newer field spellings are tried in turn. */
function bandwidthOf(a: Record<string, unknown>): number {
  if (has(a, 'body_size') || has(a, 'header_size')) return num(a.body_size) + num(a.header_size);
  if (has(a, 'resp_body_bytes') || has(a, 'resp_header_bytes')) return num(a.resp_body_bytes) + num(a.resp_header_bytes);
  return num(a.bandwidth);
}

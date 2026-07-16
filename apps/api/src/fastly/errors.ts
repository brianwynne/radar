// Fastly connector errors. The API token is NEVER included in an error, message or cause.

export type FastlyErrorCode =
  | 'FASTLY_AUTH' // 401/403 — token invalid or lacks a required read scope
  | 'FASTLY_RATE_LIMITED' // 429
  | 'FASTLY_UPSTREAM_TIMEOUT'
  | 'FASTLY_UPSTREAM_UNAVAILABLE' // 5xx / network
  | 'FASTLY_INVALID_RESPONSE'
  | 'FASTLY_REQUEST_FAILED'; // API returned a non-ok/unexpected body

const TRANSIENT: ReadonlySet<FastlyErrorCode> = new Set([
  'FASTLY_RATE_LIMITED',
  'FASTLY_UPSTREAM_TIMEOUT',
  'FASTLY_UPSTREAM_UNAVAILABLE',
]);

export class FastlyError extends Error {
  readonly code: FastlyErrorCode;
  readonly transient: boolean;
  readonly correlationId?: string;

  constructor(code: FastlyErrorCode, message?: string, opts: { correlationId?: string; transient?: boolean; cause?: unknown } = {}) {
    super(message ?? code, { cause: opts.cause });
    this.name = 'FastlyError';
    this.code = code;
    this.transient = opts.transient ?? TRANSIENT.has(code);
    this.correlationId = opts.correlationId;
  }

  static fromStatus(status: number, correlationId?: string): FastlyError {
    if (status === 401 || status === 403) return new FastlyError('FASTLY_AUTH', `Fastly returned ${status}.`, { correlationId, transient: false });
    if (status === 429) return new FastlyError('FASTLY_RATE_LIMITED', 'Fastly rate limited the request.', { correlationId });
    if (status >= 500) return new FastlyError('FASTLY_UPSTREAM_UNAVAILABLE', `Fastly returned ${status}.`, { correlationId });
    return new FastlyError('FASTLY_REQUEST_FAILED', `Fastly returned ${status}.`, { correlationId, transient: false });
  }
}

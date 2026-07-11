// Normalised NS1 upstream failures (docs/ns1/developer-guide.md §20). Errors carry a
// safe, generic message and NEVER include upstream secrets, request headers, or raw
// response bodies. `status` is retained for internal logging only, not for clients.

export type Ns1ErrorCode =
  | 'NS1_AUTH' // authentication / permission failure (401, 403)
  | 'NS1_NOT_FOUND' // resource not found (404)
  | 'NS1_RATE_LIMITED' // account-level rate limit (429)
  | 'NS1_UPSTREAM_TIMEOUT' // request exceeded the configured timeout
  | 'NS1_INVALID_RESPONSE' // non-JSON or wire-shape validation failure
  | 'NS1_UPSTREAM_UNAVAILABLE'; // 5xx, network error, or other transient upstream failure

const SAFE_MESSAGE: Record<Ns1ErrorCode, string> = {
  NS1_AUTH: 'NS1 authentication or permission failed.',
  NS1_NOT_FOUND: 'The requested NS1 resource was not found.',
  NS1_RATE_LIMITED: 'NS1 rate limit reached; please retry shortly.',
  NS1_UPSTREAM_TIMEOUT: 'The NS1 request timed out.',
  NS1_INVALID_RESPONSE: 'The NS1 response could not be validated.',
  NS1_UPSTREAM_UNAVAILABLE: 'Unable to retrieve data from NS1.',
};

export interface Ns1ErrorOptions {
  status?: number;
  correlationId?: string;
  /** Whether an idempotent GET may be safely retried for this failure. */
  transient?: boolean;
  cause?: unknown;
}

export class Ns1Error extends Error {
  readonly code: Ns1ErrorCode;
  readonly status?: number;
  readonly correlationId?: string;
  readonly transient: boolean;

  constructor(code: Ns1ErrorCode, message?: string, options: Ns1ErrorOptions = {}) {
    super(message ?? SAFE_MESSAGE[code]);
    this.name = 'Ns1Error';
    this.code = code;
    this.status = options.status;
    this.correlationId = options.correlationId;
    this.transient = options.transient ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Map an HTTP status to a normalised error. Only 5xx are treated as retryable. */
  static fromStatus(status: number, correlationId?: string): Ns1Error {
    if (status === 401 || status === 403) {
      return new Ns1Error('NS1_AUTH', undefined, { status, correlationId, transient: false });
    }
    if (status === 404) {
      return new Ns1Error('NS1_NOT_FOUND', undefined, { status, correlationId, transient: false });
    }
    if (status === 429) {
      // Surfaced, not auto-retried, to avoid compounding an account rate limit.
      return new Ns1Error('NS1_RATE_LIMITED', undefined, { status, correlationId, transient: false });
    }
    if (status >= 500) {
      return new Ns1Error('NS1_UPSTREAM_UNAVAILABLE', undefined, { status, correlationId, transient: true });
    }
    return new Ns1Error('NS1_UPSTREAM_UNAVAILABLE', undefined, { status, correlationId, transient: false });
  }
}

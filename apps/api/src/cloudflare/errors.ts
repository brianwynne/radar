// Cloudflare connector errors. The API token is NEVER included in an error, message or cause.

export type CloudflareErrorCode =
  | 'CLOUDFLARE_AUTH' // 401/403 — token invalid or lacks a required read scope
  | 'CLOUDFLARE_RATE_LIMITED' // 429
  | 'CLOUDFLARE_UPSTREAM_TIMEOUT'
  | 'CLOUDFLARE_UPSTREAM_UNAVAILABLE' // 5xx / network
  | 'CLOUDFLARE_INVALID_RESPONSE'
  | 'CLOUDFLARE_REQUEST_FAILED'; // API returned success:false

const TRANSIENT: ReadonlySet<CloudflareErrorCode> = new Set([
  'CLOUDFLARE_RATE_LIMITED',
  'CLOUDFLARE_UPSTREAM_TIMEOUT',
  'CLOUDFLARE_UPSTREAM_UNAVAILABLE',
]);

export class CloudflareError extends Error {
  readonly code: CloudflareErrorCode;
  readonly transient: boolean;
  readonly correlationId?: string;

  constructor(code: CloudflareErrorCode, message?: string, opts: { correlationId?: string; transient?: boolean; cause?: unknown } = {}) {
    super(message ?? code, { cause: opts.cause });
    this.name = 'CloudflareError';
    this.code = code;
    this.transient = opts.transient ?? TRANSIENT.has(code);
    this.correlationId = opts.correlationId;
  }

  static fromStatus(status: number, correlationId?: string): CloudflareError {
    if (status === 401 || status === 403) return new CloudflareError('CLOUDFLARE_AUTH', `Cloudflare returned ${status}.`, { correlationId, transient: false });
    if (status === 429) return new CloudflareError('CLOUDFLARE_RATE_LIMITED', 'Cloudflare rate limited the request.', { correlationId });
    if (status >= 500) return new CloudflareError('CLOUDFLARE_UPSTREAM_UNAVAILABLE', `Cloudflare returned ${status}.`, { correlationId });
    return new CloudflareError('CLOUDFLARE_REQUEST_FAILED', `Cloudflare returned ${status}.`, { correlationId, transient: false });
  }
}

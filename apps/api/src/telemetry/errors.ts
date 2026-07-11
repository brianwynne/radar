// Normalised telemetry-source failures. Errors carry a safe, generic message and NEVER
// include the source URL, query, credentials, request headers or raw response bodies.
// `status` is retained for internal logging only.

export type TelemetryErrorCode =
  | 'TELEMETRY_AUTH' // authentication/permission failure (401, 403)
  | 'TELEMETRY_UPSTREAM_TIMEOUT' // request exceeded the configured timeout
  | 'TELEMETRY_INVALID_RESPONSE' // non-JSON or unexpected wire shape
  | 'TELEMETRY_UPSTREAM_UNAVAILABLE'; // 5xx, network error, or other transient failure

const SAFE_MESSAGE: Record<TelemetryErrorCode, string> = {
  TELEMETRY_AUTH: 'Telemetry source authentication or permission failed.',
  TELEMETRY_UPSTREAM_TIMEOUT: 'The telemetry request timed out.',
  TELEMETRY_INVALID_RESPONSE: 'The telemetry response could not be validated.',
  TELEMETRY_UPSTREAM_UNAVAILABLE: 'Unable to retrieve telemetry from the source.',
};

export interface TelemetryErrorOptions {
  status?: number;
  transient?: boolean;
  cause?: unknown;
}

export class TelemetryError extends Error {
  readonly code: TelemetryErrorCode;
  readonly status?: number;
  readonly transient: boolean;

  constructor(code: TelemetryErrorCode, message?: string, options: TelemetryErrorOptions = {}) {
    super(message ?? SAFE_MESSAGE[code]);
    this.name = 'TelemetryError';
    this.code = code;
    this.status = options.status;
    this.transient = options.transient ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  static fromStatus(status: number): TelemetryError {
    if (status === 401 || status === 403) return new TelemetryError('TELEMETRY_AUTH', undefined, { status, transient: false });
    if (status >= 500) return new TelemetryError('TELEMETRY_UPSTREAM_UNAVAILABLE', undefined, { status, transient: true });
    return new TelemetryError('TELEMETRY_UPSTREAM_UNAVAILABLE', undefined, { status, transient: false });
  }
}

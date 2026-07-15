// Normalised CloudVision-source failures. Errors carry a safe, generic message and NEVER
// include the endpoint URL, the service-account token, request headers or raw response
// bodies. `status` is retained for internal logging only. Mirrors telemetry/errors.ts.

export type CloudVisionErrorCode =
  | 'CLOUDVISION_AUTH' // authentication/permission failure (401, 403)
  | 'CLOUDVISION_TOKEN_EXPIRED' // the service-account token is expired/invalid (a 401 sub-case)
  | 'CLOUDVISION_UPSTREAM_TIMEOUT' // request exceeded the configured timeout
  | 'CLOUDVISION_INVALID_RESPONSE' // non-JSON or unexpected wire shape
  | 'CLOUDVISION_UPSTREAM_UNAVAILABLE'; // 5xx, network error, or other transient failure

const SAFE_MESSAGE: Record<CloudVisionErrorCode, string> = {
  CLOUDVISION_AUTH: 'CloudVision authentication or permission failed.',
  CLOUDVISION_TOKEN_EXPIRED: 'The CloudVision service-account token is expired or invalid.',
  CLOUDVISION_UPSTREAM_TIMEOUT: 'The CloudVision request timed out.',
  CLOUDVISION_INVALID_RESPONSE: 'The CloudVision response could not be validated.',
  CLOUDVISION_UPSTREAM_UNAVAILABLE: 'Unable to retrieve telemetry from CloudVision.',
};

export interface CloudVisionErrorOptions {
  status?: number;
  transient?: boolean;
  correlationId?: string;
  cause?: unknown;
}

export class CloudVisionError extends Error {
  readonly code: CloudVisionErrorCode;
  readonly status?: number;
  readonly transient: boolean;
  readonly correlationId?: string;

  constructor(code: CloudVisionErrorCode, message?: string, options: CloudVisionErrorOptions = {}) {
    super(message ?? SAFE_MESSAGE[code]);
    this.name = 'CloudVisionError';
    this.code = code;
    this.status = options.status;
    this.transient = options.transient ?? false;
    this.correlationId = options.correlationId;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Map an HTTP status to a safe error. 401/403 → AUTH (non-transient — do not retry a
   *  rejected credential); 5xx → UNAVAILABLE (transient); other 4xx → non-transient. */
  static fromStatus(status: number, correlationId?: string): CloudVisionError {
    if (status === 401 || status === 403) {
      return new CloudVisionError('CLOUDVISION_AUTH', undefined, { status, transient: false, correlationId });
    }
    if (status >= 500) {
      return new CloudVisionError('CLOUDVISION_UPSTREAM_UNAVAILABLE', undefined, { status, transient: true, correlationId });
    }
    return new CloudVisionError('CLOUDVISION_UPSTREAM_UNAVAILABLE', undefined, { status, transient: false, correlationId });
  }
}

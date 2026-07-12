// Credential redaction + sanitised fixture generation. Deeply redacts any credential-like
// KEY while PRESERVING structure and order (object key insertion order and array order are
// kept). Never mutates the input. Used before anything derived from a live payload is stored
// or returned.
const SENSITIVE_KEY = /(^|[._-])(key|token|secret|password|passwd|authorization|auth|cookie|credential|bearer|apikey|api_key)s?([._-]|$)/i;
const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Deep clone with credential-like keys redacted; object key order and array order preserved. */
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactDeep(v);
    }
    return out;
  }
  return value;
}

/** Collect the key paths that a credential-like key redaction touched (for transparency). */
export function redactedPaths(value: unknown, prefix = ''): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...redactedPaths(v, `${prefix}[${i}]`)));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (isSensitiveKey(k)) out.push(path);
      else out.push(...redactedPaths(v, path));
    }
  }
  return out;
}

// Response-header handling for Stream Tests: redact anything sensitive before it is persisted or
// shown, and add provider-specific *request* headers that make cache-tier evidence observable.

// Header names that must never be persisted or displayed (credentials, cookies, signed material).
const REDACT = /(^set-cookie$|^cookie$|^authorization$|^proxy-authorization$|^www-authenticate$|^proxy-authenticate$|token|secret|signature|hmac|api[-_]?key|password|bearer|credential)/i;

/** Copy response headers, replacing the value of any sensitive header with a marker (name kept). */
export function redactResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = REDACT.test(k) ? '[redacted]' : v;
  return out;
}

/** Read-only request headers to add per provider so cache tiers report themselves. Akamai only emits
 *  X-Cache / X-Cache-Remote when asked via this debug Pragma; it does not change what is delivered. */
export function providerRequestHeaders(provider: string): Record<string, string> {
  if (provider === 'akamai') return { Pragma: 'akamai-x-cache-on, akamai-x-cache-remote-on' };
  return {};
}

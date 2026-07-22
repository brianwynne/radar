// SSRF hardening for operator-configurable outbound endpoints. Connector endpoints are semi-trusted
// (only an Engineer with connector.manage can set them), but a mistyped or malicious value should not
// be able to steer RADAR at a cloud metadata service or an internal host — especially since the
// request carries the connector's credential. This is a LITERAL-host guard: it inspects the hostname
// as written and does NOT resolve DNS, so a public name that resolves to an internal IP is out of
// scope here (add resolve-and-check if that threat model applies).

export class UnsafeEndpointError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'UnsafeEndpointError';
  }
}

// IPv4 literals that must never be an outbound target.
const PRIVATE_V4 = [
  /^0\./, // "this" network
  /^10\./, // RFC1918
  /^127\./, // loopback
  /^169\.254\./, // link-local (incl. 169.254.169.254 cloud metadata)
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 172.16/12
  /^192\.168\./, // RFC1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

/** True when `host` (a hostname or IP literal, no brackets) is a loopback/internal/link-local target. */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets if present
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  // IPv6 loopback/link-local (fe80::/10) + unique-local (fc00::/7 → fc/fd prefixes).
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

/** Validate an operator-supplied outbound endpoint, returning the parsed URL. Throws UnsafeEndpointError
 *  on a non-http(s) scheme, embedded credentials, an internal/loopback host, or (when required) non-HTTPS. */
export function assertPublicHttpEndpoint(raw: string, opts: { requireHttps?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeEndpointError('Endpoint must be a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeEndpointError('Endpoint must be an http(s) URL.');
  if (opts.requireHttps && url.protocol !== 'https:') throw new UnsafeEndpointError('Endpoint must use HTTPS.');
  if (url.username || url.password) throw new UnsafeEndpointError('Endpoint must not embed credentials.');
  if (isInternalHost(url.hostname)) throw new UnsafeEndpointError('Endpoint must not point at an internal, loopback, or link-local address.');
  return url;
}

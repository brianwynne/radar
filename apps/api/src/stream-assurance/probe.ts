// The Stream Assurance "connect-to" probe: fetch a public URL (e.g. https://live.rte.ie/init.mp4)
// while DIALLING a chosen CDN target host/IP — the equivalent of `curl --connect-to`. TLS
// verification stays ON and the certificate is validated against the public hostname (via SNI); only
// the TCP destination and the forwarded Host header are overridden. Responses are strictly bounded
// (timeout, max size, no automatic cross-host redirects). Never disables cert verification, never
// mutates global DNS. Callers MUST validate the target with the SSRF guard first.
import http from 'node:http';
import https from 'node:https';

export interface ProbeRequest {
  /** The public URL whose hostname drives SNI, the default Host header and the request path. */
  publicUrl: string;
  /** Host or IP to actually connect to (the connect-to target). */
  connectHost: string;
  /** Port to connect to (defaults to the URL's port, else 443/80 by scheme). */
  connectPort?: number;
  /** Host header to forward to the target (defaults to the public URL host). */
  hostHeader?: string;
  /** TLS SNI + cert-identity host (defaults to the public URL host). */
  sni?: string;
  /** Extra request headers (e.g. bounded diagnostic headers in diagnostic mode). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ProbeResponse {
  status: number;
  /** Lower-cased response headers. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** True when the body was cut off at maxBytes. */
  truncated: boolean;
  timingMs: number;
  /** Whether TLS was used and the SNI presented. */
  tls: { used: boolean; sni: string | null };
}

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — inits/fragments are far smaller

/** Fetch `publicUrl` but connect to `connectHost`. Rejects on transport/TLS/timeout errors. */
export function probe(req: ProbeRequest): Promise<ProbeResponse> {
  const url = new URL(req.publicUrl);
  const isHttps = url.protocol === 'https:';
  const publicHost = url.hostname;
  const port = req.connectPort ?? (url.port ? Number(url.port) : isHttps ? 443 : 80);
  const hostHeader = req.hostHeader ?? publicHost;
  const sni = req.sni ?? publicHost;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const started = Date.now();

  const headers: Record<string, string> = { host: hostHeader, 'accept-encoding': 'identity', ...(req.headers ?? {}) };
  // Keep our own Host authoritative even if a caller passed one under a different case.
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'host' && k !== 'host') delete headers[k];
  headers.host = hostHeader;

  const options: https.RequestOptions = {
    hostname: req.connectHost, // dial the connect-to target
    port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers,
    timeout: timeoutMs,
    ...(isHttps ? { servername: sni, rejectUnauthorized: true } : {}), // SNI + keep TLS verification
  };

  const transport = isHttps ? https : http;

  return new Promise<ProbeResponse>((resolve, reject) => {
    const request = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      res.on('data', (chunk: Buffer) => {
        if (truncated) return;
        total += chunk.length;
        if (total > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
          res.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      const finish = () => {
        const headersOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headersOut[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        resolve({
          status: res.statusCode ?? 0,
          headers: headersOut,
          body: new Uint8Array(Buffer.concat(chunks)),
          truncated,
          timingMs: Date.now() - started,
          tls: { used: isHttps, sni: isHttps ? sni : null },
        });
      };
      res.on('end', finish);
      res.on('close', () => { if (truncated) finish(); });
      res.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`probe timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

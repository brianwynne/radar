// A bounded, SSRF-checked redirect-following fetch. The RTÉ entitlement chain resolves through
// cross-host 302s (tokenised entry URL → Google DAI create → DAI session manifest), so unlike the
// connect-to CDN probe we must follow redirects — but re-validate the SSRF guard on EVERY hop (a
// redirect is an attacker-influenced URL) and cap the hop count. Each hop is a direct fetch (dial the
// URL's own host); TLS verification stays on via the probe.
import { probe } from './probe.js';
import { validateTarget, type SsrfPolicy } from './ssrf.js';

export interface FollowResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** The URL that finally returned a non-redirect response. */
  finalUrl: string;
  /** The intermediate URLs that redirected (in order), for evidence. */
  redirects: string[];
}

export interface FollowOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Fetch `startUrl`, following up to `maxRedirects` cross-host redirects, SSRF-checked at each hop. */
export async function fetchFollowingRedirects(startUrl: string, policy: SsrfPolicy, opts: FollowOptions = {}): Promise<FollowResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const redirects: string[] = [];
  let url = startUrl;

  for (let hop = 0; ; hop++) {
    let host: string;
    try { host = new URL(url).hostname; } catch { throw new Error(`invalid URL in redirect chain: ${url}`); }
    const decision = validateTarget({ connectHost: host }, policy);
    if (!decision.ok) throw new Error(`blocked by SSRF policy (${decision.category}) at ${host}`);

    const res = await probe({ publicUrl: url, connectHost: host, hostHeader: host, sni: host, headers: opts.headers, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
    const location = res.headers['location'];
    if (REDIRECT_STATUS.has(res.status) && location) {
      if (hop >= maxRedirects) throw new Error(`too many redirects (>${maxRedirects}) from ${startUrl}`);
      let next: string;
      try { next = new URL(location, url).href; } catch { throw new Error(`invalid redirect target '${location}'`); }
      redirects.push(url);
      url = next;
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, finalUrl: url, redirects };
  }
}

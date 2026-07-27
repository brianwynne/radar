// Stream Assurance observation glue: for each configured endpoint, validate the target (SSRF), fetch
// the object with the connect-to probe, parse it with the pure @radar/engine core, and build an
// EndpointObservation; then classify the set across CDNs. This is the connector-execution layer — all
// standards/DRM/classification decisions live in the engine, keeping RADAR's core/connector split.
import { streamAssurance as sa } from '@radar/engine';
import { probe } from './probe.js';
import { validateTarget, type SsrfPolicy } from './ssrf.js';

export interface EndpointConfig {
  endpointId: string;
  provider: sa.CdnKind;
  role: 'reference' | 'candidate';
  /** Public URL of the object (drives SNI, default Host header and path). */
  publicUrl: string;
  /** Connect-to target host/IP. */
  connectHost: string;
  connectPort?: number;
  /** Host header the endpoint forwards to origin. */
  hostHeader?: string;
  sni?: string;
  /** Explicitly-approved managed internal endpoint (allows on-net/loopback targets per policy). */
  managedInternal?: boolean;
  /** Expected origin hostname (for forwarded-Host mismatch detection). */
  originHost?: string | null;
  /** Response header names carrying the internal origin identity. */
  identityHeaders?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface EndpointResult {
  observation: sa.EndpointObservation;
  init?: sa.InitSegmentInfo;
  error?: string;
}

const hostOf = (u: string): string => { try { return new URL(u).hostname; } catch { return ''; } };

/** Fetch and parse one endpoint's init object into an observation. Never throws. */
export async function observeInit(cfg: EndpointConfig, policy: SsrfPolicy): Promise<EndpointResult> {
  const forwardedHost = cfg.hostHeader ?? hostOf(cfg.publicUrl);
  const base: sa.EndpointObservation = {
    endpointId: cfg.endpointId, provider: cfg.provider, role: cfg.role,
    reachable: false, httpStatus: null, kid: null, lastModified: null,
    cdn: sa.parseCdnHeaders(cfg.provider, {}), forwardedHost, originHost: cfg.originHost ?? null,
  };

  const decision = validateTarget({ connectHost: cfg.connectHost, managedInternal: cfg.managedInternal }, policy);
  if (!decision.ok) return { observation: base, error: `blocked by SSRF policy (${decision.category}): ${decision.reason}` };

  try {
    const res = await probe({
      publicUrl: cfg.publicUrl, connectHost: cfg.connectHost, connectPort: cfg.connectPort,
      hostHeader: cfg.hostHeader, sni: cfg.sni, headers: cfg.headers, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes,
    });
    const cdn = sa.parseCdnHeaders(cfg.provider, res.headers, { originIdentityHeaders: cfg.identityHeaders });
    let init: sa.InitSegmentInfo | undefined;
    let kid: string | null = null;
    if (res.status >= 200 && res.status < 300 && res.body.length > 0) {
      const parsed = sa.parseBoxes(res.body);
      init = sa.analyseInitSegment(res.body, parsed.boxes);
      kid = init.cenc.defaultKid;
    }
    return {
      init,
      observation: {
        endpointId: cfg.endpointId, provider: cfg.provider, role: cfg.role,
        reachable: res.status >= 200 && res.status < 400,
        httpStatus: res.status, kid, lastModified: res.headers['last-modified'] ?? null,
        cdn, forwardedHost, originHost: cfg.originHost ?? null,
      },
    };
  } catch (e) {
    return { observation: base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Observe every endpoint concurrently and classify the set (the cross-CDN / DRM findings). */
export async function observeAndClassify(
  cfgs: EndpointConfig[],
  policy: SsrfPolicy,
  opts: { authoritativeKid?: string | null; nowMs?: number } = {},
): Promise<{ results: EndpointResult[]; findings: sa.Finding[] }> {
  const results = await Promise.all(cfgs.map((c) => observeInit(c, policy)));
  const findings = sa.classifyCrossCdn(results.map((r) => r.observation), { authoritativeKid: opts.authoritativeKid, nowMs: opts.nowMs });
  return { results, findings };
}

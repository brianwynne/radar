// Cross-CDN and DRM classification engine. Given per-endpoint observations of the SAME logical
// object, it decides not just THAT endpoints disagree but WHY — distinguishing a stale edge cache,
// a stale shield, and an origin-side variant / origin-selection (forwarded-Host) problem. This is
// the logic that reproduces the reference incident: Akamai returned an old KID with edge+parent both
// MISS and a months-old Last-Modified, which points at origin, not the CDN cache.
//
// Correctness is NOT decided by majority vote. The expected value is resolved by priority:
//   1. authoritative expected value (packager/key workflow)
//   2. configured reference endpoint
//   3. semantic consensus — informational evidence only.
import type { CdnKind, CdnObservation } from './cdn-headers.js';
import { rule, type Classification, type Protocol, type Severity, type SpecFinding } from './rules.js';

export type Layer = 'edge' | 'shield' | 'origin' | 'packager' | 'config' | 'unknown';
export type ExpectedSource = 'authoritative' | 'reference' | 'consensus' | 'none';

export interface EndpointObservation {
  endpointId: string;
  provider: CdnKind;
  role: 'reference' | 'candidate';
  reachable: boolean;
  httpStatus: number | null;
  /** default_KID from the init segment tenc (identifier only). */
  kid: string | null;
  lastModified: string | null;
  cdn: CdnObservation;
  /** Host header the endpoint forwards to origin (from its configuration). */
  forwardedHost?: string | null;
  /** Expected origin hostname for the service. */
  originHost?: string | null;
}

export interface Finding {
  ruleId: string;
  classification: Classification;
  severity: Severity;
  endpointId: string;
  provider: CdnKind;
  protocol: Protocol;
  likelyLayer: Layer;
  explanation: string;
  remediation: string;
  evidence: Record<string, unknown>;
}

export interface ClassifyOptions {
  /** Authoritative expected KID from the packager/key workflow (highest priority). */
  authoritativeKid?: string | null;
  /** ISO time to age Last-Modified against (defaults to Date-free: only relative age when both present). */
  nowMs?: number;
}

const norm = (kid: string | null | undefined): string | null => (kid ? kid.toLowerCase() : null);

/** Attach endpoint context to a manifest-level standards finding so it can join a run's findings. */
export function withEndpoint(f: SpecFinding, endpointId: string, provider: CdnKind, likelyLayer: Layer = 'packager'): Finding {
  return { ...f, endpointId, provider, likelyLayer };
}

/** Resolve the expected KID and where it came from, by the documented priority. */
export function resolveExpectedKid(observations: EndpointObservation[], authoritativeKid?: string | null): { kid: string | null; source: ExpectedSource } {
  if (authoritativeKid) return { kid: norm(authoritativeKid), source: 'authoritative' };
  const ref = observations.find((o) => o.role === 'reference' && o.kid);
  if (ref) return { kid: norm(ref.kid), source: 'reference' };
  // Consensus (mode) — informational only.
  const counts = new Map<string, number>();
  for (const o of observations) { const k = norm(o.kid); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
  let best: string | null = null; let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return { kid: best, source: best ? 'consensus' : 'none' };
}

const ageDays = (lastModified: string | null, nowMs?: number): number | null => {
  if (!lastModified || nowMs == null) return null;
  const t = Date.parse(lastModified);
  return Number.isFinite(t) ? Math.round((nowMs - t) / 86_400_000) : null;
};

/** Classify KID disagreement across CDN endpoints for one logical object. */
export function classifyCrossCdn(observations: EndpointObservation[], opts: ClassifyOptions = {}): Finding[] {
  const findings: Finding[] = [];

  // Unreachable objects first.
  for (const o of observations) {
    if (!o.reachable) {
      const r = rule('SA-OBJ-001');
      findings.push({
        ruleId: r.id, classification: 'UNREACHABLE_OBJECT', severity: r.severity, endpointId: o.endpointId,
        provider: o.provider, protocol: 'cmaf', likelyLayer: o.cdn.fetchedFromOrigin ? 'origin' : 'edge',
        explanation: `${o.provider} did not return the object within the timeout (status ${o.httpStatus ?? 'none'}).`,
        remediation: r.remediation, evidence: { httpStatus: o.httpStatus },
      });
    }
  }

  const { kid: expected, source } = resolveExpectedKid(observations, opts.authoritativeKid);
  if (!expected) return findings;

  const refIdentity = observations.find((o) => o.role === 'reference')?.cdn.originIdentity ?? null;

  for (const o of observations) {
    if (!o.reachable || o.role === 'reference') continue;
    const observed = norm(o.kid);

    // Origin identity drift (independent of KID) — divergent origin selection.
    if (refIdentity && o.cdn.originIdentity && o.cdn.originIdentity !== refIdentity) {
      const r = rule('SA-CDN-004');
      findings.push({
        ruleId: r.id, classification: 'ORIGIN_IDENTITY_DRIFT', severity: r.severity, endpointId: o.endpointId,
        provider: o.provider, protocol: 'cmaf', likelyLayer: 'config',
        explanation: `${o.provider} reports origin '${o.cdn.originIdentity}' where the reference reports '${refIdentity}'.`,
        remediation: r.remediation, evidence: { originIdentity: o.cdn.originIdentity, referenceOrigin: refIdentity },
      });
    }

    if (!observed || observed === expected) continue;

    // KID mismatch — decide the responsible layer from the cache evidence.
    const hostMismatch = !!(o.forwardedHost && o.originHost && o.forwardedHost.toLowerCase() !== o.originHost.toLowerCase());
    const lmAge = ageDays(o.lastModified, opts.nowMs);
    const evidence: Record<string, unknown> = {
      expectedKid: expected, expectedFrom: source, observedKid: observed,
      edge: o.cdn.edge, parent: o.cdn.parent, fetchedFromOrigin: o.cdn.fetchedFromOrigin,
      lastModified: o.lastModified, lastModifiedAgeDays: lmAge,
      forwardedHost: o.forwardedHost ?? null, originHost: o.originHost ?? null, hostHeaderMismatch: hostMismatch,
    };

    if (o.cdn.fetchedFromOrigin) {
      // Edge AND parent both missed → the object came from origin, not a stale CDN cache.
      const r = rule('SA-CDN-001');
      const hostClause = hostMismatch
        ? ` It forwarded Host '${o.forwardedHost}' while the origin hostname is '${o.originHost}'; aligning the forwarded Host with the origin corrects origin selection.`
        : ' Check origin selection and whether the origin holds a different/older variant of this object.';
      findings.push({
        ruleId: r.id, classification: 'ORIGIN_VARIANT_MISMATCH', severity: r.severity, endpointId: o.endpointId,
        provider: o.provider, protocol: 'cenc', likelyLayer: hostMismatch ? 'config' : 'origin',
        explanation:
          `${o.provider} returned KID ${observed} but the ${source} value is ${expected}. Its edge and parent tiers both reported cache MISS, so it fetched this object from origin` +
          (lmAge != null && lmAge > 7 ? ` (Last-Modified ~${lmAge} days old)` : '') +
          ` — the stale/wrong object is coming from the origin, not a stale CDN cache.${hostClause}`,
        remediation: r.remediation, evidence,
      });
    } else if (o.cdn.edge === 'miss' && o.cdn.parent === 'hit') {
      const r = rule('SA-CDN-003');
      findings.push({
        ruleId: r.id, classification: 'CDN_SHIELD_STALE', severity: r.severity, endpointId: o.endpointId,
        provider: o.provider, protocol: 'cenc', likelyLayer: 'shield',
        explanation: `${o.provider} edge MISSED but its parent/shield HIT and returned KID ${observed} (expected ${expected}) — the shield tier holds a stale object.`,
        remediation: r.remediation, evidence,
      });
    } else if (o.cdn.edge === 'hit') {
      const r = rule('SA-CDN-002');
      findings.push({
        ruleId: r.id, classification: 'CDN_EDGE_STALE', severity: r.severity, endpointId: o.endpointId,
        provider: o.provider, protocol: 'cenc', likelyLayer: 'edge',
        explanation: `${o.provider} edge HIT and returned KID ${observed} (expected ${expected}) — the edge cache holds a stale object.`,
        remediation: r.remediation, evidence,
      });
    } else {
      const r = rule('SA-CENC-002');
      findings.push({
        ruleId: r.id, classification: 'DRM_KID_MISMATCH', severity: r.severity, endpointId: o.endpointId,
        provider: o.provider, protocol: 'cenc', likelyLayer: 'unknown',
        explanation: `${o.provider} returned KID ${observed} but the ${source} value is ${expected}; cache tier evidence is inconclusive.`,
        remediation: r.remediation, evidence,
      });
    }
  }

  return findings;
}

export interface DrmSignallingInput {
  endpointId: string;
  provider: CdnKind;
  mpdDefaultKid?: string | null;
  initKid?: string | null;
  mediaKid?: string | null;
  declaredSystems?: string[]; // DRM system IDs from MPD/HLS
  psshSystems?: string[]; // system IDs present in the init segment
}

/** Compare DRM signalling across MPD ↔ init ↔ media and declared-systems ↔ PSSH. */
export function classifyDrmSignalling(input: DrmSignallingInput): Finding[] {
  const findings: Finding[] = [];
  const mpd = norm(input.mpdDefaultKid), init = norm(input.initKid), media = norm(input.mediaKid);

  if (mpd && init && mpd !== init) {
    const r = rule('SA-CENC-001');
    findings.push({
      ruleId: r.id, classification: 'MANIFEST_INIT_MISMATCH', severity: r.severity, endpointId: input.endpointId,
      provider: input.provider, protocol: 'cenc', likelyLayer: 'packager',
      explanation: `MPD default_KID ${mpd} does not match the init segment tenc KID ${init}.`,
      remediation: r.remediation, evidence: { mpdDefaultKid: mpd, initKid: init },
    });
  }
  if (init && media && init !== media) {
    const r = rule('SA-CENC-001');
    findings.push({
      ruleId: r.id, classification: 'INIT_MEDIA_MISMATCH', severity: r.severity, endpointId: input.endpointId,
      provider: input.provider, protocol: 'cenc', likelyLayer: 'packager',
      explanation: `Init segment KID ${init} does not match the sampled media fragment KID ${media}.`,
      remediation: r.remediation, evidence: { initKid: init, mediaKid: media },
    });
  }
  if (input.declaredSystems && input.psshSystems) {
    const declared = new Set(input.declaredSystems.map((s) => s.toLowerCase()));
    const present = new Set(input.psshSystems.map((s) => s.toLowerCase()));
    const missing = [...declared].filter((s) => !present.has(s));
    const extra = [...present].filter((s) => !declared.has(s));
    if (missing.length || extra.length) {
      const r = rule('SA-CENC-004');
      findings.push({
        ruleId: r.id, classification: 'SPEC_CONFORMANCE_ERROR', severity: r.severity, endpointId: input.endpointId,
        provider: input.provider, protocol: 'cenc', likelyLayer: 'packager',
        explanation: `Declared DRM systems and packaged PSSH systems disagree (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`,
        remediation: r.remediation, evidence: { declared: [...declared], present: [...present], missing, extra },
      });
    }
  }
  return findings;
}

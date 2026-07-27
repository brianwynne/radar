import { describe, it, expect } from 'vitest';
import {
  classifyCrossCdn, classifyDrmSignalling, resolveExpectedKid,
  type CdnObservation, type EndpointObservation,
} from '../../src/stream-assurance/index.js';

const CURRENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OLD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const cdn = (o: Partial<CdnObservation>): CdnObservation => ({
  cdn: 'akamai', edge: 'unknown', parent: 'unknown', fetchedFromOrigin: false,
  originIdentity: null, servedBy: null, age: null, ...o,
});

const NOW = Date.parse('2026-07-27T00:00:00Z');

describe('classifyCrossCdn — WHY endpoints disagree', () => {
  it('reproduces the incident: Akamai stale-from-origin + forwarded-Host mismatch ⇒ ORIGIN_VARIANT_MISMATCH (not edge-cache)', () => {
    const obs: EndpointObservation[] = [
      { // Fastly = reference: connected to live.rte.host and forwarded the same Host — current KID.
        endpointId: 'fastly', provider: 'fastly', role: 'reference', reachable: true, httpStatus: 200,
        kid: CURRENT, lastModified: '2026-07-26T12:00:00Z',
        cdn: cdn({ cdn: 'fastly', edge: 'hit', parent: 'unknown' }),
        forwardedHost: 'live.rte.host', originHost: 'live.rte.host',
      },
      { // Akamai: edge AND parent MISS (fetched from origin), old KID, months-old Last-Modified,
        // forwarded Host live.rte.ie while origin hostname is live.rte.host.
        endpointId: 'akamai', provider: 'akamai', role: 'candidate', reachable: true, httpStatus: 200,
        kid: OLD, lastModified: '2026-01-01T00:00:00Z',
        cdn: cdn({ cdn: 'akamai', edge: 'miss', parent: 'miss', fetchedFromOrigin: true }),
        forwardedHost: 'live.rte.ie', originHost: 'live.rte.host',
      },
    ];
    const findings = classifyCrossCdn(obs, { nowMs: NOW });
    const f = findings.find((x) => x.endpointId === 'akamai')!;
    expect(f).toBeDefined();
    expect(f.classification).toBe('ORIGIN_VARIANT_MISMATCH');
    expect(f.ruleId).toBe('SA-CDN-001');
    expect(f.likelyLayer).toBe('config'); // Host-header mismatch, not a stale cache
    expect(f.severity).toBe('critical');
    expect(f.explanation).toMatch(/edge and parent tiers both reported cache MISS/);
    expect(f.explanation).toMatch(/origin, not a stale CDN cache/);
    expect(f.explanation).toMatch(/live\.rte\.ie/);
    expect(f.evidence.hostHeaderMismatch).toBe(true);
    expect(f.evidence.expectedFrom).toBe('reference');
    expect(f.evidence.lastModifiedAgeDays as number).toBeGreaterThan(100);
    // It must NOT be classified merely as an edge-cache problem.
    expect(f.classification).not.toBe('CDN_EDGE_STALE');
  });

  it('edge HIT with a stale object ⇒ CDN_EDGE_STALE', () => {
    const findings = classifyCrossCdn([
      { endpointId: 'ref', provider: 'realta', role: 'reference', reachable: true, httpStatus: 200, kid: CURRENT, lastModified: null, cdn: cdn({ cdn: 'realta' }) },
      { endpointId: 'akamai', provider: 'akamai', role: 'candidate', reachable: true, httpStatus: 200, kid: OLD, lastModified: null, cdn: cdn({ edge: 'hit' }) },
    ]);
    const f = findings.find((x) => x.endpointId === 'akamai')!;
    expect(f.classification).toBe('CDN_EDGE_STALE');
    expect(f.ruleId).toBe('SA-CDN-002');
    expect(f.likelyLayer).toBe('edge');
  });

  it('edge MISS but shield HIT ⇒ CDN_SHIELD_STALE', () => {
    const findings = classifyCrossCdn([
      { endpointId: 'ref', provider: 'realta', role: 'reference', reachable: true, httpStatus: 200, kid: CURRENT, lastModified: null, cdn: cdn({ cdn: 'realta' }) },
      { endpointId: 'akamai', provider: 'akamai', role: 'candidate', reachable: true, httpStatus: 200, kid: OLD, lastModified: null, cdn: cdn({ edge: 'miss', parent: 'hit' }) },
    ]);
    const f = findings.find((x) => x.endpointId === 'akamai')!;
    expect(f.classification).toBe('CDN_SHIELD_STALE');
    expect(f.likelyLayer).toBe('shield');
  });

  it('matching KIDs ⇒ no KID finding', () => {
    const findings = classifyCrossCdn([
      { endpointId: 'ref', provider: 'realta', role: 'reference', reachable: true, httpStatus: 200, kid: CURRENT, lastModified: null, cdn: cdn({ cdn: 'realta' }) },
      { endpointId: 'akamai', provider: 'akamai', role: 'candidate', reachable: true, httpStatus: 200, kid: CURRENT, lastModified: null, cdn: cdn({ edge: 'hit' }) },
    ]);
    expect(findings.filter((f) => f.classification !== 'ORIGIN_IDENTITY_DRIFT')).toHaveLength(0);
  });

  it('an authoritative expected KID overrides the reference endpoint', () => {
    const { kid, source } = resolveExpectedKid(
      [{ endpointId: 'ref', provider: 'realta', role: 'reference', reachable: true, httpStatus: 200, kid: OLD, lastModified: null, cdn: cdn({}) }],
      CURRENT,
    );
    expect(kid).toBe(CURRENT);
    expect(source).toBe('authoritative');
  });

  it('unreachable object ⇒ UNREACHABLE_OBJECT', () => {
    const findings = classifyCrossCdn([
      { endpointId: 'akamai', provider: 'akamai', role: 'candidate', reachable: false, httpStatus: 504, kid: null, lastModified: null, cdn: cdn({}) },
    ]);
    expect(findings[0].classification).toBe('UNREACHABLE_OBJECT');
    expect(findings[0].ruleId).toBe('SA-OBJ-001');
  });
});

describe('classifyDrmSignalling — MPD ↔ init ↔ media', () => {
  it('MPD default_KID ≠ init tenc KID ⇒ MANIFEST_INIT_MISMATCH', () => {
    const f = classifyDrmSignalling({ endpointId: 'e', provider: 'akamai', mpdDefaultKid: CURRENT, initKid: OLD });
    expect(f[0].classification).toBe('MANIFEST_INIT_MISMATCH');
    expect(f[0].ruleId).toBe('SA-CENC-001');
    expect(f[0].likelyLayer).toBe('packager');
  });

  it('declared DRM systems ≠ packaged PSSH systems ⇒ conformance error', () => {
    const f = classifyDrmSignalling({ endpointId: 'e', provider: 'fastly', declaredSystems: ['edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'], psshSystems: ['9a04f079-9840-4286-ab92-e65be0885f95'] });
    expect(f[0].ruleId).toBe('SA-CENC-004');
    expect(f[0].classification).toBe('SPEC_CONFORMANCE_ERROR');
  });

  it('consistent signalling ⇒ no findings', () => {
    expect(classifyDrmSignalling({ endpointId: 'e', provider: 'akamai', mpdDefaultKid: CURRENT, initKid: CURRENT, mediaKid: CURRENT })).toHaveLength(0);
  });
});

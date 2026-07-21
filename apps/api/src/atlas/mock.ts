// Deterministic mock resolver snapshot for dev/tests — shaped exactly like a live one, including
// the Cloudflare CW/PW pool split (185.54.104 vs .105) and the Three no-coverage gap.
import type { AtlasConfig } from './config.js';
import type { AtlasResolverClient } from './client.js';
import type { ResolverCheck, ResolverManager } from './manager.js';
import type { ResolverIdentitySnapshot, ResolverIspView, ResolverSnapshot } from './types.js';

const OBS = '2026-07-20T22:00:00.000Z';

const covered = (isp: string, asn: number, id: number, pools: Record<string, number>, edge: { min: number; max: number }): ResolverIspView => ({
  isp, asn, measurementId: id, covered: true, probeCount: 6, resolverCount: 9, ispResolverCount: 8, publicResolverCount: 1, localResolverCount: 0,
  platforms: { Réalta: 8 }, pools,
  recordName: 'livebase.nsone.rte.ie', edgeName: 'liveedge.rte.ie', vips: ['185.54.104.4', '185.54.105.12'],
  edgeTtl: edge, apexTtl: { min: 40, max: 300 }, recordTtl: { min: 40, max: 300 },
  // NS1 record published at 300s → steering frozen ~5 min (the real, current state).
  steeringImpeded: true, steeringWindowSecs: 300,
  honoursLowTtl: edge.max <= 35, observedAt: OBS,
  samples: [
    { probeId: 27252, resolver: '192.168.1.1', public: false, local: false, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.105.12'], apexTtl: 87, recordTtl: 87, edgeTtl: edge.min, observedAt: OBS },
    { probeId: 61509, resolver: '10.0.16.2', public: false, local: false, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.104.4'], apexTtl: 298, recordTtl: 298, edgeTtl: edge.max, observedAt: OBS },
  ],
});

function mockSnapshot(cfg: AtlasConfig, pollingEnabled: boolean): ResolverSnapshot {
  return {
    provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'Synthetic RIPE Atlas resolver data.', retrievedAt: new Date().toISOString() },
    target: cfg.target, observedAt: OBS, warnings: [], pollingEnabled,
    isps: [
      covered('Eir', 5466, 192119190, { '185.54.104': 4, '185.54.105': 5 }, { min: 26, max: 30 }),
      covered('Sky', 5607, 192119191, { '185.54.104': 6, '185.54.105': 3 }, { min: 28, max: 30 }),
      covered('Virgin/LG', 6830, 192119193, { '185.54.104': 5, '185.54.105': 4 }, { min: 25, max: 30 }),
      covered('Vodafone', 15502, 192119194, { '185.54.104': 3, '185.54.105': 6 }, { min: 29, max: 30 }),
      { isp: 'Three', asn: 13280, measurementId: null, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, localResolverCount: 0, platforms: {}, pools: {}, recordName: null, edgeName: null, vips: [], edgeTtl: null, apexTtl: null, recordTtl: null, steeringImpeded: null, steeringWindowSecs: null, honoursLowTtl: null, observedAt: null, samples: [] },
    ],
  };
}

function mockIdentity(): ResolverIdentitySnapshot {
  const isp = (isp: string, asn: number, resolvers: { resolver: string; public: boolean; probeCount: number; ecs: string | null; ecsPrefix: number | null }[]) => {
    const own = resolvers.filter((r) => !r.public);
    return {
      isp, asn, covered: true, resolverCount: resolvers.length,
      ispResolverCount: own.length, publicResolverCount: resolvers.length - own.length,
      resolvers,
      sendsEcs: own.some((r) => r.ecs !== null),
      ecsPrefixes: [...new Set(own.map((r) => r.ecsPrefix).filter((x): x is number => x !== null))].sort((a, b) => a - b),
      observedAt: OBS,
    };
  };
  return {
    provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'Synthetic resolver-identity data.', retrievedAt: new Date().toISOString() },
    observedAt: OBS, warnings: [],
    isps: [
      isp('Eir', 5466, [{ resolver: '2001:bb0:0:200::11', public: false, probeCount: 5, ecs: '51.171.0.0/24', ecsPrefix: 24 }, { resolver: '162.158.37.194', public: true, probeCount: 1, ecs: '2001:bb6::/56', ecsPrefix: 56 }]),
      isp('Sky', 5607, [{ resolver: '90.207.238.97', public: false, probeCount: 4, ecs: '90.207.0.0/20', ecsPrefix: 20 }]),
      isp('Virgin/LG', 6830, [{ resolver: '81.17.242.1', public: false, probeCount: 3, ecs: null, ecsPrefix: null }]),
      isp('Vodafone', 15502, [{ resolver: '2a02:8080::53', public: false, probeCount: 3, ecs: '2a02:8080::/32', ecsPrefix: 32 }]),
      { isp: 'Three', asn: 13280, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, resolvers: [], sendsEcs: false, ecsPrefixes: [], observedAt: null },
    ],
  };
}

/** Mock manager — flips the polling flag locally and returns the synthetic snapshot. */
export class MockAtlasManager implements ResolverManager {
  private enabled = true;
  constructor(private readonly cfg: AtlasConfig) {}
  pollingEnabled() { return this.enabled; }
  async snapshot() { return mockSnapshot(this.cfg, this.enabled); }
  async checkNow() { return { checks: [{ isp: 'Eir', asn: 5466, measurementId: 900001 }, { isp: 'Sky', asn: 5607, measurementId: 900002 }] as ResolverCheck[], startedAt: new Date().toISOString() }; }
  async checkResults(_checks: ResolverCheck[]) { return { snapshot: mockSnapshot(this.cfg, this.enabled), pending: false }; }
  async setPolling(enabled: boolean) { this.enabled = enabled; return { pollingEnabled: this.enabled }; }
  async identity() { return mockIdentity(); }
}

export class MockAtlasClient implements AtlasResolverClient {
  constructor(private readonly cfg: AtlasConfig) {}
  async getSnapshot(): Promise<ResolverSnapshot> {
    return {
      provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'Synthetic RIPE Atlas resolver data.', retrievedAt: new Date().toISOString() },
      target: this.cfg.target,
      observedAt: OBS,
      warnings: [],
      isps: [
        covered('Eir', 5466, 192119190, { '185.54.104': 4, '185.54.105': 5 }, { min: 26, max: 30 }),
        covered('Sky', 5607, 192119191, { '185.54.104': 6, '185.54.105': 3 }, { min: 28, max: 30 }),
        covered('Virgin/LG', 6830, 192119193, { '185.54.104': 5, '185.54.105': 4 }, { min: 25, max: 30 }),
        covered('Vodafone', 15502, 192119194, { '185.54.104': 3, '185.54.105': 6 }, { min: 29, max: 30 }),
        { isp: 'Three', asn: 13280, measurementId: null, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, localResolverCount: 0, platforms: {}, pools: {}, recordName: null, edgeName: null, vips: [], edgeTtl: null, apexTtl: null, recordTtl: null, steeringImpeded: null, steeringWindowSecs: null, honoursLowTtl: null, observedAt: null, samples: [] },
      ],
    };
  }
}

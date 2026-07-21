// Deterministic mock resolver snapshot for dev/tests — shaped exactly like a live one, including
// the Cloudflare CW/PW pool split (185.54.104 vs .105) and the Three no-coverage gap.
import type { AtlasConfig } from './config.js';
import type { AtlasResolverClient } from './client.js';
import type { ResolverCheck, ResolverManager } from './manager.js';
import type { ResolverIspView, ResolverSnapshot } from './types.js';

const OBS = '2026-07-20T22:00:00.000Z';

const covered = (isp: string, asn: number, id: number, pools: Record<string, number>, edge: { min: number; max: number }): ResolverIspView => ({
  isp, asn, measurementId: id, covered: true, probeCount: 6, resolverCount: 9, ispResolverCount: 8, publicResolverCount: 1,
  platforms: { Réalta: 8 }, pools, edgeTtl: edge, apexTtl: { min: 40, max: 300 },
  honoursLowTtl: edge.max <= 35, observedAt: OBS,
  samples: [
    { probeId: 27252, resolver: '192.168.1.1', public: false, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.105.12'], apexTtl: 87, edgeTtl: edge.min, observedAt: OBS },
    { probeId: 61509, resolver: '10.0.16.2', public: false, platform: 'Réalta', target: 'liveedge.rte.ie', vips: ['185.54.104.4'], apexTtl: 298, edgeTtl: edge.max, observedAt: OBS },
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
      { isp: 'Three', asn: 13280, measurementId: null, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, platforms: {}, pools: {}, edgeTtl: null, apexTtl: null, honoursLowTtl: null, observedAt: null, samples: [] },
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
        { isp: 'Three', asn: 13280, measurementId: null, covered: false, note: 'No RIPE Atlas probe coverage for this ISP.', probeCount: 0, resolverCount: 0, ispResolverCount: 0, publicResolverCount: 0, platforms: {}, pools: {}, edgeTtl: null, apexTtl: null, honoursLowTtl: null, observedAt: null, samples: [] },
      ],
    };
  }
}

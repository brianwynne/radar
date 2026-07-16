// Deterministic, clearly-labelled MOCK Fastly client (no credentials) and a DISABLED client
// (honest "not connected"). The mock mirrors realistic RTÉ delivery shapes: a high-hit-ratio VOD
// service and a live service (lower hit ratio, one service showing elevated 5xx).
import { summarise } from './http-client.js';
import type { FastlyClient, FastlyServiceStats, FastlySnapshot } from './types.js';

const WINDOW = 600; // 10 minutes

function svc(
  serviceId: string, serviceName: string,
  v: { requests: number; hits: number; miss: number; bandwidthBytes: number; originFetches: number; s2: number; s3: number; s4: number; s5: number },
): FastlyServiceStats {
  const cacheable = v.hits + v.miss;
  const pct1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    serviceId, serviceName, windowSeconds: WINDOW,
    requests: v.requests,
    requestsPerSecond: Math.round((v.requests / WINDOW) * 10) / 10,
    hits: v.hits, miss: v.miss,
    hitRatioPercent: cacheable > 0 ? pct1((v.hits / cacheable) * 100) : null,
    bandwidthBytes: v.bandwidthBytes,
    bandwidthBps: Math.round((v.bandwidthBytes * 8) / WINDOW),
    originFetches: v.originFetches,
    originOffloadPercent: pct1(Math.min(100, Math.max(0, (1 - v.originFetches / v.requests) * 100))),
    status2xx: v.s2, status3xx: v.s3, status4xx: v.s4, status5xx: v.s5,
    errorRatePercent: pct1((v.s5 / v.requests) * 100),
  };
}

const SERVICES: FastlyServiceStats[] = [
  svc('SU1z2x3RTEplayervod00', 'RTÉ Player VOD', {
    requests: 5_400_000, hits: 4_968_000, miss: 432_000, bandwidthBytes: 2_600_000_000_000, originFetches: 410_000,
    s2: 5_180_000, s3: 150_000, s4: 61_000, s5: 9_000,
  }),
  svc('SU9a8b7RTElive000000', 'RTÉ Live', {
    requests: 2_100_000, hits: 1_575_000, miss: 525_000, bandwidthBytes: 1_400_000_000_000, originFetches: 500_000,
    s2: 2_010_000, s3: 41_000, s4: 33_000, s5: 16_000,
  }),
  svc('SU5c6d7RTEnews000000', 'RTÉ News Now', {
    requests: 640_000, hits: 601_600, miss: 38_400, bandwidthBytes: 210_000_000_000, originFetches: 34_000,
    s2: 612_000, s3: 14_000, s4: 10_500, s5: 3_500,
  }),
];

export class MockFastlyClient implements FastlyClient {
  constructor(private readonly now: () => number = () => Date.now()) {}
  async getSnapshot(): Promise<FastlySnapshot> {
    const at = new Date(this.now()).toISOString();
    return {
      source: 'mock', capturedAt: at,
      services: SERVICES, summary: summarise(SERVICES),
      provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'MOCK / SYNTHETIC Fastly CDN telemetry — not production data.', retrievedAt: at },
      warnings: [],
    };
  }
}

export class DisabledFastlyClient implements FastlyClient {
  constructor(private readonly now: () => number = () => Date.now()) {}
  async getSnapshot(): Promise<FastlySnapshot> {
    const at = new Date(this.now()).toISOString();
    return {
      source: 'disabled', capturedAt: at, services: [],
      summary: { serviceCount: 0, totalRequestsPerSecond: 0, totalBandwidthBps: 0, avgHitRatioPercent: null },
      provenance: { source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true, notice: 'Fastly connector is disabled.', retrievedAt: at },
      warnings: [],
    };
  }
}

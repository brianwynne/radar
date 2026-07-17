// Deterministic, clearly-labelled MOCK Cloudflare client (no credentials) and a DISABLED client
// (honest "not connected"). The mock mirrors the real RTÉ shape: origin pools of Réalta caches and
// load balancers steering across them, including the richer fields (origin steering, load shedding,
// session affinity, adaptive routing, per-origin RTT + region health, observed by-origin traffic).
import { summarise } from './http-client.js';
import type { CloudflareClient, CloudflareFocusedPoolHealth, CloudflareLoadBalancer, CloudflareOrigin, CloudflarePool, CloudflareSnapshot } from './types.js';

/** Reduce a pool's origins to the fast-refresh health subset (mock: reuses the origin's fields). */
const focusedHealth = (p: CloudflarePool): CloudflareFocusedPoolHealth => ({ id: p.id, origins: p.origins.map((o) => ({ address: o.address, rttMs: o.rttMs, regionHealth: o.regionHealth })) });

function origin(name: string, address: string, ok: boolean): CloudflareOrigin {
  const base = 9 + (address.charCodeAt(address.length - 1) % 9);
  return {
    name, address, weight: 1, enabled: true, healthy: ok, failureReason: ok ? null : 'monitor: connection refused',
    hostHeader: 'origin.rte.ie', rttMs: ok ? base : null,
    regionHealth: [
      { region: 'WEU', healthy: ok, rttMs: ok ? base : null, failureReason: ok ? null : 'connection refused' },
      { region: 'ENAM', healthy: ok, rttMs: ok ? base + 66 : null, failureReason: ok ? null : 'connection refused' },
    ],
  };
}

function pool(id: string, name: string, origins: [string, string, boolean][], healthy: boolean): CloudflarePool {
  const os = origins.map(([oname, address, ok]) => origin(oname, address, ok));
  return {
    id, name, description: null, enabled: true, healthy, monitorId: 'mon-' + id, minimumOrigins: 1,
    healthCheck: { type: 'https', method: 'GET', path: '/player/monitoring/alive', expectedCodes: '200', expectedBody: 'OK', intervalSeconds: 60, timeoutSeconds: 5, retries: 2, port: 443, consecutiveUp: 2, consecutiveDown: 3, followRedirects: false, allowInsecure: false },
    origins: os, healthyOrigins: os.filter((o) => o.enabled && o.healthy === true).length, totalOrigins: os.length,
    originSteeringPolicy: 'least_outstanding_requests',
    loadShedding: { defaultPercent: 0, defaultPolicy: 'hash', sessionPercent: 0, sessionPolicy: 'hash' },
    checkRegions: ['WEU', 'ENAM'], notificationEmail: 'noc@rte.ie',
  };
}

const POOLS: CloudflarePool[] = [
  pool('citywest', 'live-realta-citywest', [
    ['cdn-mem-ctw-1.rte.host', '185.54.105.0', true], ['cdn-mem-ctw-2.rte.host', '185.54.105.4', true],
    ['cdn-mem-ctw-3.rte.host', '185.54.105.8', true], ['cdn-mem-ctw-4.rte.host', '185.54.105.12', true],
  ], true),
  pool('parkwest', 'live-realta-parkwest', [
    ['cdn-mem-pw-1.rte.host', '185.54.106.0', true], ['cdn-mem-pw-2.rte.host', '185.54.106.4', true],
    ['cdn-mem-pw-3.rte.host', '185.54.106.8', false], ['cdn-mem-pw-4.rte.host', '185.54.106.12', true],
  ], true),
  pool('vod', 'vod-edge-caches', [
    ['vod-1.rte.host', '185.54.107.1', true], ['vod-2.rte.host', '185.54.107.2', true],
  ], true),
];

const poolName = new Map(POOLS.map((p) => [p.id, p.name]));
const steer = (id: string, weight: number | null = null) => ({ poolId: id, poolName: poolName.get(id) ?? null, weight });

const LOAD_BALANCERS: CloudflareLoadBalancer[] = [
  {
    id: 'lb-liveedge', name: 'liveedge.rte.ie', zoneName: 'rte.ie', enabled: true, proxied: false,
    steeringPolicy: 'random', defaultPools: [steer('citywest', 0.5), steer('parkwest', 0.5)], fallbackPool: steer('parkwest'),
    regionPools: {}, popPools: {}, countryPools: { IE: [steer('citywest', 0.5), steer('parkwest', 0.5)] },
    sessionAffinity: 'cookie', sessionAffinityTtl: 1800,
    sessionAffinityAttributes: { samesite: 'Auto', secure: 'Auto', drainDuration: 60, zeroDowntimeFailover: 'sticky' },
    locationStrategy: 'pop', adaptiveRoutingFailoverAcrossPools: true, randomSteeringDefaultWeight: 1, ttlSeconds: 30,
    observed: {
      windowHours: 1, totalRequests: 10480,
      byPool: [{ key: 'live-realta-citywest', requests: 5281, sharePercent: 50.4 }, { key: 'live-realta-parkwest', requests: 5199, sharePercent: 49.6 }],
      byRegion: [{ key: 'WEU', requests: 10480, sharePercent: 100 }],
      byColo: [{ key: 'DUB', requests: 10480, sharePercent: 100 }],
      byOrigin: [
        { key: 'cdn-mem-ctw-1.rte.host', requests: 2661, sharePercent: 25.4 }, { key: 'cdn-mem-ctw-2.rte.host', requests: 2620, sharePercent: 25.0 },
        { key: 'cdn-mem-pw-1.rte.host', requests: 2640, sharePercent: 25.2 }, { key: 'cdn-mem-pw-2.rte.host', requests: 2559, sharePercent: 24.4 },
      ],
    },
  },
  {
    id: 'lb-vod', name: 'vod.rte.ie', zoneName: 'rte.ie', enabled: true, proxied: true,
    steeringPolicy: 'off', defaultPools: [steer('vod')], fallbackPool: steer('vod'),
    regionPools: {}, popPools: {}, countryPools: {}, sessionAffinity: 'none', sessionAffinityTtl: null,
    sessionAffinityAttributes: null, locationStrategy: 'pop', adaptiveRoutingFailoverAcrossPools: false,
    randomSteeringDefaultWeight: null, ttlSeconds: 30, observed: null,
  },
];

export class MockCloudflareClient implements CloudflareClient {
  constructor(private readonly now: () => number = () => Date.now()) {}
  async getSnapshot(): Promise<CloudflareSnapshot> {
    const at = new Date(this.now()).toISOString();
    return {
      source: 'mock', capturedAt: at,
      loadBalancers: LOAD_BALANCERS, pools: POOLS, summary: summarise(POOLS, LOAD_BALANCERS),
      provenance: { source: 'mock', synthetic: true, readOnly: true, informationalOnly: true, notice: 'MOCK / SYNTHETIC Cloudflare Load Balancing — not production data.', retrievedAt: at },
      warnings: [],
    };
  }
  async getPoolsHealth(ids: string[]): Promise<CloudflareFocusedPoolHealth[]> {
    return POOLS.filter((p) => ids.includes(p.id)).map(focusedHealth);
  }
}

export class DisabledCloudflareClient implements CloudflareClient {
  constructor(private readonly now: () => number = () => Date.now()) {}
  async getSnapshot(): Promise<CloudflareSnapshot> {
    const at = new Date(this.now()).toISOString();
    return {
      source: 'disabled', capturedAt: at, loadBalancers: [], pools: [],
      summary: { loadBalancerCount: 0, poolCount: 0, originCount: 0, unhealthyPools: 0, unhealthyOrigins: 0 },
      provenance: { source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true, notice: 'Cloudflare connector is disabled.', retrievedAt: at },
      warnings: [],
    };
  }
  async getPoolsHealth(): Promise<CloudflareFocusedPoolHealth[]> { return []; }
}

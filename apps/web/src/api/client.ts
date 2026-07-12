// Thin typed client over the radar-api REST routes. Same-origin: /api is served by the
// reverse proxy (prod) or the Vite dev proxy. No NS1 key ever reaches the browser.
import type {
  ActivityResponse,
  AuditListResponse,
  CompareCurrentResponse,
  CompareResponse,
  ExplainRequest,
  ExplainResponse,
  LiveSteeringConfig,
  LiveSteeringEventsResponse,
  LiveSteeringStateResponse,
  CacheNodeResponse,
  CacheNodesResponse,
  CachePoolResponse,
  CachePoolsResponse,
  NetworkPathResponse,
  NetworkPathsResponse,
  Ns1Status,
  OriginResponse,
  Principal,
  RawRecordResponse,
  RecordResponse,
  SnapshotCaptureResponse,
  SnapshotDetail,
  SnapshotHistory,
  ZoneResponse,
  ZonesResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const enc = encodeURIComponent;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the RADAR API.');
  }
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const body = (json ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, body.code ?? 'ERROR', body.message ?? res.statusText);
  }
  return json as T;
}

export const api = {
  me: () => request<Principal>('/api/v1/me'),
  ns1Config: () => request<Ns1Status>('/api/v1/ns1/config'),
  zones: () => request<ZonesResponse>('/api/v1/ns1/zones'),
  zone: (zone: string) => request<ZoneResponse>(`/api/v1/ns1/zones/${enc(zone)}`),
  record: (zone: string, domain: string, type: string) =>
    request<RecordResponse>(`/api/v1/ns1/zones/${enc(zone)}/${enc(domain)}/${enc(type)}`),
  rawRecord: (zone: string, domain: string, type: string) =>
    request<RawRecordResponse>(`/api/v1/ns1/zones/${enc(zone)}/${enc(domain)}/${enc(type)}/raw`),
  explain: (body: ExplainRequest) =>
    request<ExplainResponse>('/api/v1/dns/explain', { method: 'POST', body: JSON.stringify(body) }),
  activity: (limit?: number) => request<ActivityResponse>(`/api/v1/ns1/activity${limit ? `?limit=${limit}` : ''}`),
  audit: (limit?: number) => request<AuditListResponse>(`/api/v1/audit${limit ? `?limit=${limit}` : ''}`),
  snapshots: (zone: string, domain: string, type: string) =>
    request<SnapshotHistory>(`/api/v1/ns1/zones/${enc(zone)}/${enc(domain)}/${enc(type)}/snapshots`),
  captureSnapshot: (zone: string, domain: string, type: string, label?: string) =>
    request<SnapshotCaptureResponse>(`/api/v1/ns1/zones/${enc(zone)}/${enc(domain)}/${enc(type)}/snapshots`, {
      method: 'POST',
      body: JSON.stringify(label ? { label } : {}),
    }),
  snapshot: (id: string) => request<{ snapshot: SnapshotDetail }>(`/api/v1/snapshots/${enc(id)}`),
  compareSnapshots: (a: string, b: string) =>
    request<CompareResponse>('/api/v1/snapshots/compare', { method: 'POST', body: JSON.stringify({ a, b }) }),
  compareCurrent: (id: string) =>
    request<CompareCurrentResponse>(`/api/v1/snapshots/${enc(id)}/compare-current`, { method: 'POST', body: JSON.stringify({}) }),
  liveSteeringConfig: () => request<LiveSteeringConfig>('/api/v1/live-steering/config'),
  liveSteeringState: (q: { isp?: string; asn?: number; record?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.isp) p.set('isp', q.isp);
    if (q.asn !== undefined) p.set('asn', String(q.asn));
    if (q.record) p.set('record', q.record);
    const qs = p.toString();
    return request<LiveSteeringStateResponse>(`/api/v1/live-steering/state${qs ? `?${qs}` : ''}`);
  },
  liveSteeringEvents: (q: { isp?: string; asn?: number; record?: string; since?: string; before?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.isp) p.set('isp', q.isp);
    if (q.asn !== undefined) p.set('asn', String(q.asn));
    if (q.record) p.set('record', q.record);
    if (q.since) p.set('since', q.since);
    if (q.before) p.set('before', q.before);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    const qs = p.toString();
    return request<LiveSteeringEventsResponse>(`/api/v1/live-steering/events${qs ? `?${qs}` : ''}`);
  },
  telemetryNetworkPaths: (q: { pathType?: string; status?: string; stale?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.pathType) p.set('pathType', q.pathType);
    if (q.status) p.set('status', q.status);
    if (q.stale !== undefined) p.set('stale', String(q.stale));
    const qs = p.toString();
    return request<NetworkPathsResponse>(`/api/v1/telemetry/network-paths${qs ? `?${qs}` : ''}`);
  },
  telemetryNetworkPath: (pathId: string) => request<NetworkPathResponse>(`/api/v1/telemetry/network-paths/${enc(pathId)}`),
  telemetryCachePools: (q: { site?: string; status?: string; stale?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.site) p.set('site', q.site);
    if (q.status) p.set('status', q.status);
    if (q.stale !== undefined) p.set('stale', String(q.stale));
    const qs = p.toString();
    return request<CachePoolsResponse>(`/api/v1/telemetry/cache-pools${qs ? `?${qs}` : ''}`);
  },
  telemetryCachePool: (poolId: string) => request<CachePoolResponse>(`/api/v1/telemetry/cache-pools/${enc(poolId)}`),
  telemetryCacheNodes: (q: { site?: string; poolId?: string; status?: string; stale?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.site) p.set('site', q.site);
    if (q.poolId) p.set('poolId', q.poolId);
    if (q.status) p.set('status', q.status);
    if (q.stale !== undefined) p.set('stale', String(q.stale));
    const qs = p.toString();
    return request<CacheNodesResponse>(`/api/v1/telemetry/cache-nodes${qs ? `?${qs}` : ''}`);
  },
  telemetryCacheNode: (nodeId: string) => request<CacheNodeResponse>(`/api/v1/telemetry/cache-nodes/${enc(nodeId)}`),
  telemetryOrigin: () => request<OriginResponse>('/api/v1/telemetry/origin'),
};

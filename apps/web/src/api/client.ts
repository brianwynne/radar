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
  DnsObservationConfigResponse,
  DnsObservationHistoryResponse,
  DnsObservationRunResponse,
  DnsObservationStateResponse,
  NetworkPathResponse,
  NetworkPathsResponse,
  NetworkStatusResponse,
  ResolverSnapshot, ResolverCheckStart, ResolverCheck, ResolverCheckResult, ResolverIdentitySnapshot,
  NetworkDevicesResponse,
  NetworkInterfacesResponse,
  NetworkLinkGroupsResponse,
  NetworkBgpPeersResponse,
  NetworkHistoryResponse,
  ConnectorSettingsResponse,
  ConnectorSettingsUpdateRequest,
  ConnectorTestResponse,
  CloudflareStatusResponse,
  CloudflareListResponse,
  CloudflareRefreshResponse,
  CloudflareLoadBalancer,
  CloudflarePool,
  CloudflareConnectionResponse,
  CloudflareConnectionUpdateRequest,
  CloudflareConnectionTestResponse,
  FastlyStatusResponse,
  FastlyServicesResponse,
  FastlyRealtimeResponse,
  AkamaiRealtimeResponse,
  AkamaiConnectionResponse,
  AkamaiConnectionUpdate,
  AkamaiConnectionTestResponse,
  Ns1ConnectionResponse,
  Ns1ConnectionUpdate,
  Ns1ConnectionTestResponse,
  FastlyConnectionResponse,
  FastlyConnectionUpdate,
  FastlyConnectionTestResponse,
  Ns1Status,
  OriginResponse,
  Principal,
  ValidationResultResponse,
  ValidationResultsResponse,
  ValidationRunResponse,
  ValidationUnsupportedFeaturesResponse,
  AsnBreakdownResponse,
  Ns1ActiveRecordResponse,
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
  asnBreakdown: (zone: string, domain: string, type: string) =>
    request<AsnBreakdownResponse>(`/api/v1/ns1/asn-breakdown/${enc(zone)}/${enc(domain)}/${enc(type)}`),
  activeRecord: () => request<Ns1ActiveRecordResponse>('/api/v1/ns1/active-record'),
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
  renameSnapshot: (id: string, label: string | null) =>
    request<{ snapshot: SnapshotDetail }>(`/api/v1/snapshots/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ label }) }),
  deleteSnapshot: (id: string) => request<void>(`/api/v1/snapshots/${enc(id)}`, { method: 'DELETE' }),
  compareSnapshots: (a: string, b: string) =>
    request<CompareResponse>('/api/v1/snapshots/compare', { method: 'POST', body: JSON.stringify({ a, b }) }),
  compareCurrent: (id: string, target?: { zone: string; domain: string; type: string }) =>
    request<CompareCurrentResponse>(`/api/v1/snapshots/${enc(id)}/compare-current`, { method: 'POST', body: JSON.stringify(target ?? {}) }),
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
  dnsObservationConfig: () => request<DnsObservationConfigResponse>('/api/v1/dns-observation/config'),
  dnsObservationState: () => request<DnsObservationStateResponse>('/api/v1/dns-observation/state'),
  dnsObservationRun: (ispId?: string) =>
    request<DnsObservationRunResponse>('/api/v1/dns-observation/run', { method: 'POST', body: JSON.stringify(ispId ? { ispId } : {}) }),
  dnsObservationHistory: (q: { isp?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.isp) p.set('isp', q.isp);
    if (q.status) p.set('status', q.status);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    const qs = p.toString();
    return request<DnsObservationHistoryResponse>(`/api/v1/dns-observation/history${qs ? `?${qs}` : ''}`);
  },
  validationRun: (body: { zone: string; domain?: string; recordType?: string; includeActivity?: boolean; includeRaw?: boolean }) =>
    request<ValidationRunResponse>('/api/v1/validation/ns1/run', { method: 'POST', body: JSON.stringify(body) }),
  validationResults: (q: { zone?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.zone) p.set('zone', q.zone);
    if (q.status) p.set('status', q.status);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    const qs = p.toString();
    return request<ValidationResultsResponse>(`/api/v1/validation/ns1/results${qs ? `?${qs}` : ''}`);
  },
  validationResult: (id: string) => request<ValidationResultResponse>(`/api/v1/validation/ns1/results/${enc(id)}`),
  validationUnsupportedFeatures: () => request<ValidationUnsupportedFeaturesResponse>('/api/v1/validation/ns1/unsupported-features'),

  // CloudVision network telemetry (read-only, informational).
  networkStatus: () => request<NetworkStatusResponse>('/api/v1/network/status'),
  resolvers: () => request<ResolverSnapshot>('/api/v1/network/resolvers'),
  resolverIdentity: () => request<ResolverIdentitySnapshot>('/api/v1/network/resolvers/identity'),
  resolverCheck: () => request<ResolverCheckStart>('/api/v1/network/resolvers/check', { method: 'POST' }),
  resolverCheckResults: (checks: ResolverCheck[]) =>
    request<ResolverCheckResult>('/api/v1/network/resolvers/check/results', { method: 'POST', body: JSON.stringify({ checks }) }),
  resolverPolling: (enabled: boolean) =>
    request<{ pollingEnabled: boolean }>('/api/v1/network/resolvers/polling', { method: 'POST', body: JSON.stringify({ enabled }) }),
  networkDevices: () => request<NetworkDevicesResponse>('/api/v1/network/devices'),
  networkInterfaces: (q: { deviceId?: string; provider?: string; linkType?: string; status?: string; unknownOnly?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.deviceId) p.set('deviceId', q.deviceId);
    if (q.provider) p.set('provider', q.provider);
    if (q.linkType) p.set('linkType', q.linkType);
    if (q.status) p.set('status', q.status);
    if (q.unknownOnly) p.set('unknownOnly', 'true');
    const qs = p.toString();
    return request<NetworkInterfacesResponse>(`/api/v1/network/interfaces${qs ? `?${qs}` : ''}`);
  },
  networkLinkGroups: () => request<NetworkLinkGroupsResponse>('/api/v1/network/link-groups'),
  networkBgpPeers: (q: { deviceId?: string; provider?: string; state?: string; established?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.deviceId) p.set('deviceId', q.deviceId);
    if (q.provider) p.set('provider', q.provider);
    if (q.state) p.set('state', q.state);
    if (q.established !== undefined) p.set('established', String(q.established));
    const qs = p.toString();
    return request<NetworkBgpPeersResponse>(`/api/v1/network/bgp-peers${qs ? `?${qs}` : ''}`);
  },
  networkHistory: (limit?: number) => request<NetworkHistoryResponse>(`/api/v1/network/history${limit ? `?limit=${limit}` : ''}`),

  // CloudVision connection settings (Engineer only). The token is write-only.
  networkConnection: () => request<ConnectorSettingsResponse>('/api/v1/network/connection'),
  networkConnectionUpdate: (body: ConnectorSettingsUpdateRequest) => request<ConnectorSettingsResponse>('/api/v1/network/connection', { method: 'PUT', body: JSON.stringify(body) }),
  networkConnectionTest: () => request<ConnectorTestResponse>('/api/v1/network/connection/test', { method: 'POST', body: JSON.stringify({}) }),

  // Réalta cache load balancing (Cloudflare) — read-only origin-pool selection downstream of NS1.
  cloudflareStatus: () => request<CloudflareStatusResponse>('/api/v1/network/cloudflare/status'),
  cloudflareLoadBalancers: () => request<CloudflareListResponse<CloudflareLoadBalancer>>('/api/v1/network/cloudflare/load-balancers'),
  cloudflarePools: () => request<CloudflareListResponse<CloudflarePool>>('/api/v1/network/cloudflare/pools'),
  cloudflareRefreshPools: (ids: string[]) => request<CloudflareRefreshResponse>(`/api/v1/network/cloudflare/pools/refresh?ids=${encodeURIComponent(ids.join(','))}`),

  // Cloudflare connection settings (Engineer only). The token is write-only.
  cloudflareConnection: () => request<CloudflareConnectionResponse>('/api/v1/network/cloudflare/connection'),
  cloudflareConnectionUpdate: (body: CloudflareConnectionUpdateRequest) => request<CloudflareConnectionResponse>('/api/v1/network/cloudflare/connection', { method: 'PUT', body: JSON.stringify(body) }),
  cloudflareConnectionTest: () => request<CloudflareConnectionTestResponse>('/api/v1/network/cloudflare/connection/test', { method: 'POST', body: JSON.stringify({}) }),

  // Fastly CDN observability — read-only per-service delivery telemetry (a commercial CDN platform).
  fastlyStatus: () => request<FastlyStatusResponse>('/api/v1/cdn/fastly/status'),
  fastlyServices: () => request<FastlyServicesResponse>('/api/v1/cdn/fastly/services'),
  fastlyRealtime: () => request<FastlyRealtimeResponse>('/api/v1/cdn/fastly/realtime'),
  akamaiRealtime: () => request<AkamaiRealtimeResponse>('/api/v1/cdn/akamai/realtime'),

  // Akamai connection settings (Engineer only). The S3 secret key is write-only.
  akamaiConnection: () => request<AkamaiConnectionResponse>('/api/v1/cdn/akamai/connection'),
  akamaiConnectionUpdate: (body: AkamaiConnectionUpdate) => request<AkamaiConnectionResponse>('/api/v1/cdn/akamai/connection', { method: 'PUT', body: JSON.stringify(body) }),
  akamaiConnectionTest: () => request<AkamaiConnectionTestResponse>('/api/v1/cdn/akamai/connection/test', { method: 'POST', body: JSON.stringify({}) }),

  // NS1 connection settings (Engineer only). The read-only NS1 key is write-only.
  ns1Connection: () => request<Ns1ConnectionResponse>('/api/v1/ns1/connection'),
  ns1ConnectionUpdate: (body: Ns1ConnectionUpdate) => request<Ns1ConnectionResponse>('/api/v1/ns1/connection', { method: 'PUT', body: JSON.stringify(body) }),
  ns1ConnectionTest: () => request<Ns1ConnectionTestResponse>('/api/v1/ns1/connection/test', { method: 'POST', body: JSON.stringify({}) }),

  // Fastly connection settings (Engineer only). The token is write-only.
  fastlyConnection: () => request<FastlyConnectionResponse>('/api/v1/cdn/fastly/connection'),
  fastlyConnectionUpdate: (body: FastlyConnectionUpdate) => request<FastlyConnectionResponse>('/api/v1/cdn/fastly/connection', { method: 'PUT', body: JSON.stringify(body) }),
  fastlyConnectionTest: () => request<FastlyConnectionTestResponse>('/api/v1/cdn/fastly/connection/test', { method: 'POST', body: JSON.stringify({}) }),
};

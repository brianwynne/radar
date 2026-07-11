// Thin typed client over the radar-api REST routes. Same-origin: /api is served by the
// reverse proxy (prod) or the Vite dev proxy. No NS1 key ever reaches the browser.
import type {
  ActivityResponse,
  ExplainRequest,
  ExplainResponse,
  Ns1Status,
  Principal,
  RawRecordResponse,
  RecordResponse,
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
};

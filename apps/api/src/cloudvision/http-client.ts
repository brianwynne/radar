// Live, READ-ONLY CloudVision client. GET-only over HTTPS with a redacted service-account
// token, a short explicit timeout, and bounded retry-with-jitter for transient failures.
// There is NO method that issues a non-GET request or accepts an arbitrary URL; the token is
// never logged. All business logic (classification, throughput, aggregation) lives in the
// adapter — this client only does transport + a thin, tolerant map into the raw contract.
//
// APIs used (documented; see docs/architecture/cloudvision-telemetry.md §"CloudVision APIs"):
//   • Device inventory — Resource API  GET {endpoint}/api/resources/inventory/v1/Device/all
//     (confirmed from the inventory.v1 gRPC/REST gateway swagger).
//   • Interface + BGP state — NetDB telemetry REST GET {endpoint}/api/v1/rest/{device}/{path}.
//     The exact Sysdb/Smash state paths are deployment/version-specific, so this mapping is
//     GROUNDED-BUT-PENDING live confirmation: any field the live shape does not provide is
//     surfaced as UNAVAILABLE — never fabricated. See the live-validation command.
import { CloudVisionError } from './errors.js';
import { buildSnapshot, counterKey, type AdapterConfig, type PreviousCounters, type RawBgpPeer, type RawDevice, type RawInterface, type RawSnapshot } from './adapter.js';
import type { ClassificationRule } from './classification.js';
import type { CloudVisionClient, NetworkStateSnapshot, OperState } from './types.js';

export interface HttpCloudVisionClientOptions {
  endpoint: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  verifyTls: boolean;
  staleAfterSeconds: number;
  expectedDeviceIds: string[];
  classificationRules: ClassificationRule[];
  providerForAsn?: Record<number, string>;
  warningPercent: number;
  criticalPercent: number;
  primaryDirection?: 'inbound' | 'outbound';
  fetchImpl?: typeof fetch;
  /** Optional undici Dispatcher (used to honour verifyTls=false); omitted = platform default. */
  dispatcher?: unknown;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

/** Interface state NetDB path (documented default; deployment-overridable in future work). */
const IF_PATH = 'Smash/interface/status/eth/phy/slice/1/intfStatus';
/** BGP peer state NetDB path (documented default). */
const BGP_PATH = 'Sysdb/routing/bgp/export/vrf/default/peerInfoStatus';

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asBig(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}
function operOf(v: unknown): OperState {
  const s = String(v ?? '').toLowerCase();
  if (s === 'up' || s === 'linkup' || s === 'connected') return 'up';
  if (s === 'down' || s === 'linkdown' || s === 'notconnect') return 'down';
  return 'unknown';
}
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export class HttpCloudVisionReadClient implements CloudVisionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  /** Previous counter readings per interface, held between polls for bandwidth derivation. */
  private previous = new Map<string, PreviousCounters>();

  constructor(private readonly opts: HttpCloudVisionClientOptions) {
    if (!/^https?:\/\//i.test(opts.endpoint)) throw new Error('HttpCloudVisionReadClient: endpoint must be an http(s) URL.');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  async getSnapshot(correlationId?: string): Promise<NetworkStateSnapshot> {
    const now = this.now();
    const devices = await this.discoverDevices(correlationId);
    const wanted = this.opts.expectedDeviceIds.length > 0 ? devices.filter((d) => this.opts.expectedDeviceIds.includes(d.id)) : devices;

    const interfaces: RawInterface[] = [];
    const bgpPeers: RawBgpPeer[] = [];
    const nextPrevious = new Map<string, PreviousCounters>();
    for (const d of wanted) {
      const ifs = await this.fetchInterfaces(d.id, now, correlationId);
      for (const itf of ifs) {
        interfaces.push(itf);
        // Roll the counters forward for the next poll's derivation.
        if (itf.inOctets !== null || itf.outOctets !== null) {
          nextPrevious.set(counterKey(itf.deviceId, itf.name), { inOctets: itf.inOctets, outOctets: itf.outOctets, at: itf.observedAt });
        }
      }
      bgpPeers.push(...(await this.fetchBgp(d.id, now, correlationId)));
    }

    const raw: RawSnapshot = { devices, interfaces, bgpPeers, previousCounters: this.previous };
    this.previous = nextPrevious;

    const cfg: AdapterConfig = {
      source: 'cloudvision',
      synthetic: false,
      now,
      staleAfterSeconds: this.opts.staleAfterSeconds,
      expectedDeviceIds: this.opts.expectedDeviceIds,
      classificationRules: this.opts.classificationRules,
      providerForAsn: this.opts.providerForAsn,
      warningPercent: this.opts.warningPercent,
      criticalPercent: this.opts.criticalPercent,
      primaryDirection: this.opts.primaryDirection,
    };
    return buildSnapshot(raw, cfg);
  }

  // ---- Inventory (Resource API) -------------------------------------------------------------

  private async discoverDevices(correlationId?: string): Promise<RawDevice[]> {
    const rows = await this.getStream('/api/resources/inventory/v1/Device/all', correlationId);
    const devices: RawDevice[] = [];
    for (const row of rows) {
      // gRPC-gateway streaming shape: { result: { value: {...Device} } }.
      const value = isObj(row) && isObj(row.result) && isObj(row.result.value) ? row.result.value : isObj(row) ? row : null;
      if (!value) continue;
      // The gRPC-gateway JSON transcoding uses proto3 camelCase (deviceId, modelName,
      // streamingStatus); accept snake_case too for portability across gateways.
      const s = (camel: string, snake: string): string | undefined => (value[camel] ?? value[snake]) as string | undefined;
      const key = isObj(value.key) ? value.key : {};
      const id = String((key.deviceId as string | undefined) ?? (key.device_id as string | undefined) ?? s('deviceId', 'device_id') ?? '');
      if (!id) continue;
      const streamingStatus = String(s('streamingStatus', 'streaming_status') ?? '');
      devices.push({
        id,
        hostname: String(value.hostname ?? value.fqdn ?? id),
        modelName: s('modelName', 'model_name') ?? null,
        softwareVersion: s('softwareVersion', 'software_version') ?? null,
        // Streaming when the status ends in ACTIVE (STREAMING_STATUS_ACTIVE) but NOT INACTIVE.
        streaming: /(^|_)ACTIVE$/i.test(streamingStatus),
        reachable: true,
        observedAt: new Date(this.now()),
      });
    }
    return devices;
  }

  // ---- NetDB telemetry (grounded; pending live confirmation) --------------------------------

  private async fetchInterfaces(deviceId: string, now: number, correlationId?: string): Promise<RawInterface[]> {
    let payload: unknown;
    try {
      payload = await this.getJson(`/api/v1/rest/${enc(deviceId)}/${IF_PATH}`, correlationId);
    } catch (err) {
      this.opts.logger?.warn({ deviceId, code: err instanceof CloudVisionError ? err.code : 'error' }, 'cloudvision: interface fetch failed');
      return [];
    }
    const updates = this.updatesOf(payload);
    const out: RawInterface[] = [];
    for (const [name, raw] of Object.entries(updates)) {
      if (!isObj(raw)) continue;
      const counters = isObj(raw.counters) ? raw.counters : {};
      out.push({
        deviceId,
        name,
        description: (raw.description as string | undefined) ?? null,
        adminState: operOf(raw.adminStatus ?? raw.admin_status),
        operState: operOf(raw.linkStatus ?? raw.oper_status ?? raw.operStatus),
        speedBps: asNum(raw.speed ?? raw.bandwidth),
        reportedInBps: asNum(raw.inBitsRate ?? raw.rxBps),
        reportedOutBps: asNum(raw.outBitsRate ?? raw.txBps),
        inOctets: asBig(counters.inOctets ?? raw.inOctets),
        outOctets: asBig(counters.outOctets ?? raw.outOctets),
        inErrors: asNum(counters.inErrors ?? raw.inErrors),
        outErrors: asNum(counters.outErrors ?? raw.outErrors),
        inDiscards: asNum(counters.inDiscards ?? raw.inDiscards),
        outDiscards: asNum(counters.outDiscards ?? raw.outDiscards),
        observedAt: new Date(now),
      });
    }
    return out;
  }

  private async fetchBgp(deviceId: string, now: number, correlationId?: string): Promise<RawBgpPeer[]> {
    let payload: unknown;
    try {
      payload = await this.getJson(`/api/v1/rest/${enc(deviceId)}/${BGP_PATH}`, correlationId);
    } catch (err) {
      this.opts.logger?.warn({ deviceId, code: err instanceof CloudVisionError ? err.code : 'error' }, 'cloudvision: bgp fetch failed');
      return [];
    }
    const updates = this.updatesOf(payload);
    const out: RawBgpPeer[] = [];
    for (const [address, raw] of Object.entries(updates)) {
      if (!isObj(raw)) continue;
      out.push({
        deviceId,
        peerAddress: address,
        peerAsn: asNum(raw.asn ?? raw.peerAsn),
        state: String(raw.state ?? raw.peerState ?? ''),
        uptimeSeconds: asNum(raw.uptime ?? raw.establishedTime),
        prefixesReceived: asNum(raw.prefixesReceived ?? raw.prefixReceived),
        prefixesAdvertised: asNum(raw.prefixesAdvertised ?? raw.prefixSent),
        observedAt: new Date(now),
      });
    }
    return out;
  }

  /** Extract a `{ key: value }` map from the documented NetDB REST shape. Tolerant: an
   *  unexpected shape yields `{}` (→ the device simply contributes no interfaces/peers,
   *  surfaced honestly), never a fabricated entry. */
  private updatesOf(payload: unknown): Record<string, unknown> {
    if (isObj(payload) && Array.isArray(payload.notifications)) {
      const merged: Record<string, unknown> = {};
      for (const n of payload.notifications) if (isObj(n) && isObj(n.updates)) Object.assign(merged, n.updates);
      return merged;
    }
    if (isObj(payload) && isObj(payload.updates)) return payload.updates as Record<string, unknown>;
    return {};
  }

  // ---- Transport ----------------------------------------------------------------------------

  private headers(correlationId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.opts.token}`, // redacted from all logs
      'User-Agent': 'radar/1.0',
    };
    if (correlationId) h['X-Correlation-ID'] = correlationId;
    return h;
  }

  private init(correlationId?: string): RequestInit {
    const init: RequestInit = { method: 'GET', headers: this.headers(correlationId), signal: AbortSignal.timeout(this.opts.timeoutMs) };
    // `dispatcher` is an undici extension to RequestInit; set it opaquely to honour verifyTls.
    if (this.opts.dispatcher) (init as unknown as Record<string, unknown>).dispatcher = this.opts.dispatcher;
    return init;
  }

  private async getJson(path: string, correlationId?: string): Promise<unknown> {
    const res = await this.request(path, correlationId);
    try {
      return await res.json();
    } catch (cause) {
      throw new CloudVisionError('CLOUDVISION_INVALID_RESPONSE', undefined, { correlationId, cause });
    }
  }

  /** Parse a possibly line-delimited (NDJSON) streaming response into an array of objects. */
  private async getStream(path: string, correlationId?: string): Promise<unknown[]> {
    const res = await this.request(path, correlationId);
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    try {
      const asJson = JSON.parse(trimmed);
      return Array.isArray(asJson) ? asJson : [asJson];
    } catch {
      // NDJSON: one JSON object per line.
      const rows: unknown[] = [];
      for (const line of trimmed.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        try {
          rows.push(JSON.parse(l));
        } catch (cause) {
          throw new CloudVisionError('CLOUDVISION_INVALID_RESPONSE', undefined, { correlationId, cause });
        }
      }
      return rows;
    }
  }

  /** GET with bounded exponential backoff + full jitter for transient failures only. */
  private async request(path: string, correlationId?: string): Promise<Response> {
    const url = `${this.opts.endpoint}${path}`;
    let lastTransient: CloudVisionError | undefined;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt));
      try {
        const res = await this.fetchImpl(url, this.init(correlationId));
        if (!res.ok) {
          const err = CloudVisionError.fromStatus(res.status, correlationId);
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        return res;
      } catch (err) {
        if (err instanceof CloudVisionError) {
          if (err.transient) {
            lastTransient = err;
            continue;
          }
          throw err;
        }
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        lastTransient = new CloudVisionError(isTimeout ? 'CLOUDVISION_UPSTREAM_TIMEOUT' : 'CLOUDVISION_UPSTREAM_UNAVAILABLE', undefined, { correlationId, transient: true, cause: err });
      }
    }
    throw lastTransient ?? new CloudVisionError('CLOUDVISION_UPSTREAM_UNAVAILABLE', undefined, { correlationId });
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(1000, 100 * 2 ** (attempt - 1));
    return Math.round(base * this.random());
  }
}

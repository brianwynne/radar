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
import { buildSnapshot, type AdapterConfig, type RawBgpPeer, type RawDevice, type RawInterface, type RawSnapshot } from './adapter.js';
import { parseBgpPeer, parseInterfaceRates, parseUtilisation, speedFromUtilisation } from './analytics-shapes.js';
import type { ClassificationRule } from './classification.js';
import type { CloudVisionClient, NetworkStateSnapshot } from './types.js';

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

// Interface names to skip (not steering-relevant): subinterfaces, loopback, management,
// VLAN/VXLAN, recirc, CPU, fabric. RADAR cares about physical edge interfaces.
const SKIP_INTERFACE = /(\.\d|^Loopback|^Management|^Vlan|^Vxlan|^Recirc|^Cpu|^Fabric)/i;
/** Analytics rate window used for the reported bandwidth (1-minute average). */
const RATE_WINDOW = '1m';
/** Cap on interfaces fetched per device per poll (defence against a huge device). */
const MAX_INTERFACES_PER_DEVICE = 200;
/** Concurrency for per-interface / per-peer analytics leaf fetches. Balanced for a ~15s poll
 *  (CloudVision's analytics data only republishes ~once a minute, so speed isn't needed);
 *  raise it if driving a shorter interval, at the cost of more simultaneous CVaaS load. */
const FETCH_CONCURRENCY = 12;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Run `fn` over `items` with bounded concurrency, preserving order; a failed item → null. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class HttpCloudVisionReadClient implements CloudVisionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: HttpCloudVisionClientOptions) {
    if (!/^https?:\/\//i.test(opts.endpoint)) throw new Error('HttpCloudVisionReadClient: endpoint must be an http(s) URL.');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  async getSnapshot(correlationId?: string): Promise<NetworkStateSnapshot> {
    const now = this.now();
    const discovered = await this.discoverDevices(correlationId);
    // When edge devices are configured, the snapshot is SCOPED to exactly those — the view
    // shows only the selected routers/switches. Add more later by extending the device list.
    const devices = this.opts.expectedDeviceIds.length > 0 ? discovered.filter((d) => this.opts.expectedDeviceIds.includes(d.id)) : discovered;

    const interfaces: RawInterface[] = [];
    const bgpPeers: RawBgpPeer[] = [];
    for (const d of devices) {
      interfaces.push(...(await this.fetchInterfaces(d.id, now, correlationId)));
      bgpPeers.push(...(await this.fetchBgp(d.id, now, correlationId)));
    }

    const raw: RawSnapshot = { devices, interfaces, bgpPeers };

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

  // ---- analytics-dataset telemetry (verified live against CVaaS) -----------------------------
  // Interface rates/utilisation + BGP peer state live in the `analytics` dataset under
  // /Devices/<id>/versioned-data/... (NOT the per-device Sysdb dataset, and NOT AQL). Paths
  // are code-defined + allow-listed here — there is no generic query proxy. All values are
  // parsed by analytics-shapes.ts; an absent field stays null (a completeness signal).

  private analyticsBase(deviceId: string, ...elements: string[]): string {
    // Each element is a single path segment (interface names contain '/', so encode the whole).
    const tail = elements.map((e) => enc(e)).join('/');
    return `/api/v1/rest/analytics/Devices/${enc(deviceId)}/versioned-data/${tail}`;
  }

  /** GET an analytics path → merged updates map + the freshest source timestamp (epoch ms). */
  private async analyticsGet(path: string, correlationId?: string): Promise<{ updates: Record<string, unknown>; observedAt: Date | null }> {
    const payload = await this.getJson(path, correlationId);
    const updates: Record<string, unknown> = {};
    let tsNs: bigint | null = null;
    if (isObj(payload) && Array.isArray(payload.notifications)) {
      for (const n of payload.notifications) {
        if (!isObj(n)) continue;
        if (isObj(n.updates)) Object.assign(updates, n.updates);
        const t = n.timestamp ?? n.time;
        if (typeof t === 'string' && /^\d+$/.test(t)) {
          const v = BigInt(t);
          if (tsNs === null || v > tsNs) tsNs = v;
        }
      }
    }
    const observedAt = tsNs === null ? null : new Date(Number(tsNs / 1_000_000n));
    return { updates, observedAt };
  }

  private async fetchInterfaces(deviceId: string, now: number, correlationId?: string): Promise<RawInterface[]> {
    let names: string[];
    try {
      const list = await this.analyticsGet(this.analyticsBase(deviceId, 'interfaces', 'data'), correlationId);
      names = Object.keys(list.updates).filter((n) => !SKIP_INTERFACE.test(n)).slice(0, MAX_INTERFACES_PER_DEVICE);
    } catch (err) {
      this.opts.logger?.warn({ deviceId, code: err instanceof CloudVisionError ? err.code : 'error' }, 'cloudvision: interface list fetch failed');
      return [];
    }
    const built = await mapLimit(names, FETCH_CONCURRENCY, (name) => this.fetchInterface(deviceId, name, now, correlationId));
    return built.filter((i): i is RawInterface => i !== null);
  }

  /** One interface: its 1-minute rates (bandwidth/errors/discards) + pre-computed utilisation.
   *  Configured speed is derived from bandwidth ÷ utilisation. */
  private async fetchInterface(deviceId: string, name: string, now: number, correlationId?: string): Promise<RawInterface | null> {
    const rates = await this.analyticsGet(this.analyticsBase(deviceId, 'interfaces', 'data', name, 'aggregate', 'rates', RATE_WINDOW), correlationId);
    if (Object.keys(rates.updates).length === 0) return null; // no rate data → omit this interface
    const r = parseInterfaceRates(rates.updates);
    let util: { inPercent: number | null; outPercent: number | null } = { inPercent: null, outPercent: null };
    try {
      util = parseUtilisation((await this.analyticsGet(this.analyticsBase(deviceId, 'interfaces', 'data', name, 'utilisation'), correlationId)).updates);
    } catch {
      // Utilisation is best-effort; the endpoint spells it "utilization".
    }
    if (util.inPercent === null && util.outPercent === null) {
      try {
        util = parseUtilisation((await this.analyticsGet(this.analyticsBase(deviceId, 'interfaces', 'data', name, 'utilization'), correlationId)).updates);
      } catch {
        // leave null → utilisation unavailable (completeness signal)
      }
    }
    const speedBps = speedFromUtilisation(r.outBps, util.outPercent) ?? speedFromUtilisation(r.inBps, util.inPercent);
    const hasData = r.inBps !== null || r.outBps !== null;
    return {
      deviceId,
      name,
      description: null, // interface description is not on the analytics node (future enrichment)
      adminState: 'unknown',
      operState: hasData ? 'up' : 'unknown',
      speedBps,
      reportedInBps: r.inBps,
      reportedOutBps: r.outBps,
      inOctets: null,
      outOctets: null,
      inErrors: r.inErrors,
      outErrors: r.outErrors,
      inDiscards: r.inDiscards,
      outDiscards: r.outDiscards,
      observedAt: rates.observedAt ?? new Date(now),
    };
  }

  private async fetchBgp(deviceId: string, now: number, correlationId?: string): Promise<RawBgpPeer[]> {
    let peerAddrs: string[];
    try {
      const list = await this.analyticsGet(this.analyticsBase(deviceId, 'routing', 'bgp', 'status', 'vrf', 'default', 'bgpPeerInfoStatusEntry'), correlationId);
      peerAddrs = Object.keys(list.updates);
    } catch (err) {
      this.opts.logger?.warn({ deviceId, code: err instanceof CloudVisionError ? err.code : 'error' }, 'cloudvision: bgp list fetch failed');
      return [];
    }
    const built = await mapLimit(peerAddrs, FETCH_CONCURRENCY, async (address) => {
      const leaf = await this.analyticsGet(this.analyticsBase(deviceId, 'routing', 'bgp', 'status', 'vrf', 'default', 'bgpPeerInfoStatusEntry', address), correlationId);
      if (Object.keys(leaf.updates).length === 0) return null;
      const p = parseBgpPeer(leaf.updates);
      const peer: RawBgpPeer = {
        deviceId,
        peerAddress: address,
        peerAsn: p.asn,
        state: p.state ?? '',
        uptimeSeconds: null, // not on this leaf (a different afi/safi table); left null
        prefixesReceived: null,
        prefixesAdvertised: null,
        observedAt: leaf.observedAt ?? new Date(now),
        // Provider is taken ONLY from the verified peer description tag, never fabricated.
        providerHint: p.provider,
      };
      return peer;
    });
    return built.filter((p): p is RawBgpPeer => p !== null);
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

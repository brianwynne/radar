// Akamai DataStream 2 AGGREGATOR. Push-driven counterpart of the Fastly realtime streamer: it takes
// batches of DS2 edge-log records (from the S3 poller, or any ingress) and folds them into a bounded,
// rolling per-CP-code per-second ring buffer, then serves the same canonical realtime snapshot the UI
// already renders. Read-only; a second with no records simply has no bucket (never fabricated).
import type { AkamaiProvenance, AkamaiSample, AkamaiSnapshot, AkamaiSource, DataStreamRecord } from './types.js';

export interface AkamaiAggregatorConfig {
  /** CP codes to observe; empty → observe every CP code that appears in the stream. */
  cpCodes: string[];
  /** CP code → friendly name (e.g. "1629049" → "LIVE.RTE.IE"). */
  names: Record<string, string>;
  /** Rolling retention window (seconds). */
  windowSeconds: number;
  source: AkamaiSource;
}

export interface AkamaiAggregatorDeps {
  now?: () => number;
}

export interface AkamaiServiceStatus {
  serviceId: string;
  serviceName: string;
  sampleCount: number;
  lastSampleAt: string | null;
}

export interface AkamaiStatus {
  enabled: boolean;
  source: AkamaiSource;
  windowSeconds: number;
  recordsIngested: number;
  lastIngestAt: string | null;
  ingestAgeSeconds: number | null;
  services: AkamaiServiceStatus[];
}

interface Bucket {
  requests: number; hits: number; miss: number; bytes: number;
  s2: number; s3: number; s4: number; s5: number;
  codes: Map<string, number>;
}
interface CpState {
  cp: string;
  buckets: Map<number, Bucket>;
  lastSecond: number | null;
}

const newBucket = (): Bucket => ({ requests: 0, hits: 0, miss: 0, bytes: 0, s2: 0, s3: 0, s4: 0, s5: 0, codes: new Map() });

export class AkamaiAggregator {
  private cpCodes: string[];
  private names: Record<string, string>;
  private windowSeconds: number;
  private source: AkamaiSource;
  private readonly now: () => number;

  private states = new Map<string, CpState>();
  private recordsIngested = 0;
  private lastIngestAt: number | null = null;

  constructor(config: AkamaiAggregatorConfig, deps: AkamaiAggregatorDeps = {}) {
    this.cpCodes = config.cpCodes;
    this.names = config.names;
    this.windowSeconds = config.windowSeconds;
    this.source = config.source;
    this.now = deps.now ?? (() => Date.now());
    for (const cp of this.cpCodes) this.states.set(cp, { cp, buckets: new Map(), lastSecond: null });
  }

  reconfigure(config: AkamaiAggregatorConfig): void {
    this.cpCodes = config.cpCodes;
    this.names = config.names;
    this.windowSeconds = config.windowSeconds;
    this.source = config.source;
    this.states = new Map(this.cpCodes.map((cp) => [cp, { cp, buckets: new Map(), lastSecond: null }]));
    this.recordsIngested = 0;
    this.lastIngestAt = null;
  }

  /** True when a CP code is observed: explicit allow-list, or observe-all when none configured. */
  private observed(cp: string): boolean {
    return this.cpCodes.length === 0 || this.cpCodes.includes(cp);
  }

  ingest(records: DataStreamRecord[]): number {
    let accepted = 0;
    for (const r of records) {
      if (!this.observed(r.cp)) continue;
      let st = this.states.get(r.cp);
      if (!st) { st = { cp: r.cp, buckets: new Map(), lastSecond: null }; this.states.set(r.cp, st); }
      let b = st.buckets.get(r.second);
      if (!b) { b = newBucket(); st.buckets.set(r.second, b); }
      b.requests += 1;
      if (r.hit) b.hits += 1; else b.miss += 1;
      b.bytes += r.bytes;
      if (r.statusCode >= 100 && r.statusCode <= 599) {
        const cls = Math.floor(r.statusCode / 100);
        if (cls === 2) b.s2 += 1; else if (cls === 3) b.s3 += 1; else if (cls === 4) b.s4 += 1; else if (cls === 5) b.s5 += 1;
        const key = String(r.statusCode);
        b.codes.set(key, (b.codes.get(key) ?? 0) + 1);
      }
      if (st.lastSecond === null || r.second > st.lastSecond) st.lastSecond = r.second;
      accepted += 1;
    }
    if (accepted > 0) { this.recordsIngested += accepted; this.lastIngestAt = this.now(); }
    this.pruneAll();
    return accepted;
  }

  private pruneAll(): void {
    const cutoff = Math.floor(this.now() / 1000) - this.windowSeconds;
    for (const st of this.states.values()) {
      for (const sec of st.buckets.keys()) if (sec < cutoff) st.buckets.delete(sec);
    }
  }

  private sampleOf(second: number, b: Bucket): AkamaiSample {
    return {
      second,
      at: new Date(second * 1000).toISOString(),
      requests: b.requests, hits: b.hits, miss: b.miss, bandwidthBytes: b.bytes,
      status2xx: b.s2, status3xx: b.s3, status4xx: b.s4, status5xx: b.s5,
      statusCodes: Object.fromEntries(b.codes),
    };
  }

  snapshot(): AkamaiSnapshot {
    this.pruneAll();
    const capturedAt = new Date(this.now()).toISOString();
    const series = [...this.states.values()].map((st) => {
      const seconds = [...st.buckets.keys()].sort((a, b) => a - b);
      const samples = seconds.map((s) => this.sampleOf(s, st.buckets.get(s)!));
      const last = samples[samples.length - 1];
      return {
        serviceId: st.cp,
        serviceName: this.names[st.cp] ?? st.cp,
        samples,
        latestRequestsPerSecond: last ? last.requests : null,
        latestBandwidthBps: last ? last.bandwidthBytes * 8 : null,
        lastSampleAt: last ? last.at : null,
      };
    });
    return {
      source: this.source,
      capturedAt,
      windowSeconds: this.windowSeconds,
      series,
      provenance: provenanceFor(this.source, capturedAt),
      warnings: [],
    };
  }

  status(): AkamaiStatus {
    const ingestAge = this.lastIngestAt !== null ? Math.max(0, Math.round((this.now() - this.lastIngestAt) / 1000)) : null;
    return {
      enabled: this.source !== 'disabled',
      source: this.source,
      windowSeconds: this.windowSeconds,
      recordsIngested: this.recordsIngested,
      lastIngestAt: this.lastIngestAt !== null ? new Date(this.lastIngestAt).toISOString() : null,
      ingestAgeSeconds: ingestAge,
      services: [...this.states.values()].map((st) => ({
        serviceId: st.cp,
        serviceName: this.names[st.cp] ?? st.cp,
        sampleCount: st.buckets.size,
        lastSampleAt: st.lastSecond !== null ? new Date(st.lastSecond * 1000).toISOString() : null,
      })),
    };
  }
}

function provenanceFor(source: AkamaiSource, at: string): AkamaiProvenance {
  const notice = source === 'disabled'
    ? 'Akamai connector is disabled.'
    : 'Akamai CDN telemetry (DataStream 2 edge logs, aggregated by RADAR) is read-only and informational. RADAR issues no Akamai writes.';
  return { source, synthetic: false, readOnly: true, informationalOnly: true, notice, retrievedAt: at };
}

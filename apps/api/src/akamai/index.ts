// Akamai connector module. Owns the aggregator, the S3 poller (the DataStream 2 → S3 → RADAR pull
// path), and an ingest entry point (the alternative HTTPS-push path / replay hook). Read-only:
// nothing here can write to Akamai. The factory selects disabled vs live from config.
import { createHash, timingSafeEqual } from 'node:crypto';
import { AkamaiAggregator, type AkamaiStatus } from './aggregator.js';
import { AkamaiS3Poller, type AkamaiS3PollerStatus } from './poller.js';
import { S3ReadClient } from './s3-client.js';
import { parseDataStreamUpload } from './datastream.js';
import type { AkamaiConfig } from './config.js';
import type { AkamaiSnapshot, AkamaiSource } from './types.js';

export { loadAkamaiConfig, type AkamaiConfig } from './config.js';
export { AkamaiAggregator, type AkamaiStatus, type AkamaiServiceStatus } from './aggregator.js';
export { AkamaiS3Poller, type AkamaiS3PollerStatus } from './poller.js';
export { S3ReadClient, signV4, parseListXml } from './s3-client.js';
export { parseDataStreamUpload, parseRecords, decodeUpload } from './datastream.js';
export type * from './types.js';

export interface AkamaiConnectorStatus {
  source: AkamaiSource;
  /** True only when a live S3 source is configured AND recently polled successfully. Replayed data
   *  arriving via the ingest route does NOT make the connector "connected" — that path is a dev/test
   *  aid, so a connector with no live S3 stream honestly reads as not connected. */
  connected: boolean;
  aggregator: AkamaiStatus;
  s3: AkamaiS3PollerStatus;
  /** Whether the shared-secret HTTPS ingest route is enabled. */
  ingestEnabled: boolean;
}

export interface AkamaiConnectorDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export class AkamaiConnector {
  private aggregator!: AkamaiAggregator;
  private poller!: AkamaiS3Poller;
  private s3!: S3ReadClient | null;
  private prefix!: string;
  private enabled!: boolean;
  private ingestSecret!: string;
  private hasS3!: boolean;
  private maxStaleMs!: number;
  private running = false;
  private readonly now: () => number;
  private readonly deps: AkamaiConnectorDeps;

  constructor(config: AkamaiConfig, deps: AkamaiConnectorDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.build(config);
  }

  /** (Re)build the aggregator + S3 client + poller from an effective config. Used by the connector
   *  manager when an Engineer changes the connection; existing accumulated data is dropped. */
  reconfigure(config: AkamaiConfig): void {
    const wasRunning = this.running;
    this.poller.stop();
    this.build(config);
    if (wasRunning) this.start();
  }

  private build(config: AkamaiConfig): void {
    this.enabled = config.enabled;
    this.ingestSecret = config.ingestSecret;
    this.aggregator = new AkamaiAggregator(
      { cpCodes: config.cpCodes, names: config.cpNames, windowSeconds: config.windowSeconds, source: config.enabled ? 'akamai' : 'disabled' },
      { now: this.deps.now },
    );
    const s3 = config.enabled && config.s3.bucket && config.s3.accessKeyId && config.s3.secretAccessKey
      ? new S3ReadClient({ bucket: config.s3.bucket, region: config.s3.region, accessKeyId: config.s3.accessKeyId, secretKey: config.s3.secretAccessKey, now: this.deps.now, fetchImpl: this.deps.fetchImpl })
      : null;
    this.s3 = s3;
    this.prefix = config.s3.prefix;
    this.hasS3 = s3 !== null;
    // A live poll is "recent" for a few poll intervals or the retention window, whichever is longer.
    this.maxStaleMs = Math.max(config.windowSeconds, config.s3.pollIntervalSeconds * 3) * 1000;
    this.poller = new AkamaiS3Poller({
      s3, aggregator: this.aggregator, prefix: config.s3.prefix, intervalMs: config.s3.pollIntervalSeconds * 1000,
      enabled: config.enabled && s3 !== null, now: this.deps.now, logger: this.deps.logger,
    });
  }

  /** Connected only when a live S3 source has polled successfully and recently. The ingest/replay
   *  route never flips this on — so with no real DataStream 2 stream the connector reads NOT CONNECTED. */
  connected(): boolean {
    if (!this.enabled || !this.hasS3) return false;
    const last = this.poller.status().lastSuccessAt;
    return last !== null && this.now() - Date.parse(last) < this.maxStaleMs;
  }

  /** Ingest a DataStream 2 upload (HTTPS-push / replay). Returns the number of records accepted. */
  ingestUpload(body: Buffer, contentEncoding?: string): number {
    return this.aggregator.ingest(parseDataStreamUpload(body, contentEncoding));
  }

  /** Whether the shared-secret ingest route should be exposed (a secret is configured). */
  ingestEnabled(): boolean {
    return this.enabled && this.ingestSecret.length > 0;
  }

  verifyIngestSecret(provided: string | undefined): boolean {
    if (this.ingestSecret.length === 0 || !provided) return false;
    // Constant-time: compare fixed-length SHA-256 digests so neither the outcome nor the length of
    // the provided key leaks via response timing (matches the SecretBox comparison discipline).
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(this.ingestSecret).digest();
    return timingSafeEqual(a, b);
  }

  /** Not connected ⇒ an honest disabled snapshot: no series (replayed/stale data is not shown as live). */
  snapshot(): AkamaiSnapshot {
    const snap = this.aggregator.snapshot();
    if (this.connected()) return snap;
    return {
      ...snap, source: 'disabled', series: [],
      provenance: { source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true, notice: 'Akamai connector is not connected — no live DataStream 2 source.', retrievedAt: snap.capturedAt },
    };
  }

  status(): AkamaiConnectorStatus {
    const connected = this.connected();
    return { source: connected ? 'akamai' : 'disabled', connected, aggregator: this.aggregator.status(), s3: this.poller.status(), ingestEnabled: this.ingestEnabled() };
  }

  /** Run one S3 poll now (used by tests and to warm the connection). */
  pollOnce(): Promise<{ ok: boolean; objects: number; records: number; error?: string }> { return this.poller.runOnce(); }

  /** Read-only connection test: one bounded S3 list against the current credentials. Never ingests. */
  async testConnection(): Promise<{ ok: boolean; error?: string; objects?: number }> {
    if (!this.enabled) return { ok: false, error: 'Connector is disabled.' };
    if (!this.s3) return { ok: false, error: 'S3 source is not configured (bucket + credentials required).' };
    try {
      const page = await this.s3.listObjects(this.prefix, { maxKeys: 1 });
      return { ok: true, objects: page.objects.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'S3 list failed.' };
    }
  }

  start(): void { this.running = true; this.poller.start(); }
  stop(): void { this.running = false; this.poller.stop(); }
}

export function createAkamaiConnector(config: AkamaiConfig, deps: AkamaiConnectorDeps = {}): AkamaiConnector {
  return new AkamaiConnector(config, deps);
}

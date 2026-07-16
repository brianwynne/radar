// Akamai connector module. Owns the aggregator, the S3 poller (the DataStream 2 → S3 → RADAR pull
// path), and an ingest entry point (the alternative HTTPS-push path / replay hook). Read-only:
// nothing here can write to Akamai. The factory selects disabled vs live from config.
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
  private readonly aggregator: AkamaiAggregator;
  private readonly poller: AkamaiS3Poller;
  private readonly source: AkamaiSource;
  private readonly ingestSecret: string;

  constructor(config: AkamaiConfig, deps: AkamaiConnectorDeps = {}) {
    this.source = config.enabled ? 'akamai' : 'disabled';
    this.ingestSecret = config.ingestSecret;
    this.aggregator = new AkamaiAggregator(
      { cpCodes: config.cpCodes, names: config.cpNames, windowSeconds: config.windowSeconds, source: this.source },
      { now: deps.now },
    );
    const s3 = config.enabled && config.s3.bucket && config.s3.accessKeyId && config.s3.secretAccessKey
      ? new S3ReadClient({ bucket: config.s3.bucket, region: config.s3.region, accessKeyId: config.s3.accessKeyId, secretKey: config.s3.secretAccessKey, now: deps.now, fetchImpl: deps.fetchImpl })
      : null;
    this.poller = new AkamaiS3Poller({
      s3, aggregator: this.aggregator, prefix: config.s3.prefix, intervalMs: config.s3.pollIntervalSeconds * 1000,
      enabled: config.enabled && s3 !== null, now: deps.now, logger: deps.logger,
    });
  }

  /** Ingest a DataStream 2 upload (HTTPS-push / replay). Returns the number of records accepted. */
  ingestUpload(body: Buffer, contentEncoding?: string): number {
    return this.aggregator.ingest(parseDataStreamUpload(body, contentEncoding));
  }

  /** Whether the shared-secret ingest route should be exposed (a secret is configured). */
  ingestEnabled(): boolean {
    return this.source !== 'disabled' && this.ingestSecret.length > 0;
  }

  verifyIngestSecret(provided: string | undefined): boolean {
    return this.ingestSecret.length > 0 && provided === this.ingestSecret;
  }

  snapshot(): AkamaiSnapshot { return this.aggregator.snapshot(); }

  status(): AkamaiConnectorStatus {
    return { source: this.source, aggregator: this.aggregator.status(), s3: this.poller.status(), ingestEnabled: this.ingestEnabled() };
  }

  start(): void { this.poller.start(); }
  stop(): void { this.poller.stop(); }
}

export function createAkamaiConnector(config: AkamaiConfig, deps: AkamaiConnectorDeps = {}): AkamaiConnector {
  return new AkamaiConnector(config, deps);
}

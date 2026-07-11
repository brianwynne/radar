// Deterministic, clearly-synthetic telemetry for the configured paths. Values are fixed
// (no randomness) and always labelled MOCK / SYNTHETIC / NOT PRODUCTION TELEMETRY via the
// sample provenance. Used for development and tests; never presented as real telemetry.
import { buildSample } from './sample.js';
import type { NetworkPathSample, NetworkPathTelemetryClient, PathMapping } from './types.js';

export interface MockTelemetryOptions {
  mappings: PathMapping[];
  staleAfterSeconds: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Per-path primary-direction utilisation fraction (0..1). Overrides the defaults below. */
  utilisation?: Record<string, number>;
  /** Path ids the source has NO data for (→ unavailable). */
  unavailablePathIds?: string[];
  /** Path ids whose observation is deliberately old (→ stale). */
  stalePathIds?: string[];
}

/** Deterministic default utilisation per path — a healthy→critical spread so the UI shows
 *  the full status range. `above_target` sits just above the 70% target; `critical` above
 *  the 90% default. */
export const MOCK_UTILISATION: Record<string, number> = {
  'eir-pni': 0.52, // healthy
  'virgin-liberty-pni': 0.74, // above_target
  'inex': 0.84, // warning
  'transit': 0.95, // critical
};

export class MockNetworkPathTelemetryClient implements NetworkPathTelemetryClient {
  private readonly now: () => number;
  private readonly util: Record<string, number>;
  private readonly unavailable: Set<string>;
  private readonly stale: Set<string>;

  constructor(private readonly opts: MockTelemetryOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.util = opts.utilisation ?? MOCK_UTILISATION;
    this.unavailable = new Set(opts.unavailablePathIds ?? []);
    this.stale = new Set(opts.stalePathIds ?? []);
  }

  private sample(mapping: PathMapping): NetworkPathSample {
    const now = this.now();
    const ctx = { now, staleAfterSeconds: this.opts.staleAfterSeconds, source: 'mock' as const, synthetic: true };
    if (this.unavailable.has(mapping.id)) return buildSample(mapping, null, ctx);

    const fraction = this.util[mapping.id] ?? 0.5;
    const outboundBps = Math.round(mapping.configuredCapacityBps * fraction);
    const inboundBps = Math.round(outboundBps * 0.35); // inbound is smaller for a delivery path
    // A deliberately-old observation for the stale demonstration.
    const ageMs = this.stale.has(mapping.id) ? (this.opts.staleAfterSeconds + 60) * 1000 : 0;
    const observedAt = new Date(now - ageMs);
    return buildSample(mapping, { inboundBps, outboundBps, observedAt }, ctx);
  }

  async getNetworkPaths(): Promise<NetworkPathSample[]> {
    return this.opts.mappings.map((m) => this.sample(m));
  }

  async getNetworkPath(pathId: string): Promise<NetworkPathSample | null> {
    const mapping = this.opts.mappings.find((m) => m.id === pathId);
    return mapping ? this.sample(mapping) : null;
  }
}

/** Telemetry-disabled client: reports the configured paths with `telemetry_not_connected`
 *  and no observed values (honest placeholder, still exposing configured capacity/target). */
export class DisabledNetworkPathTelemetryClient implements NetworkPathTelemetryClient {
  constructor(private readonly mappings: PathMapping[], private readonly staleAfterSeconds: number) {}

  private sample(mapping: PathMapping): NetworkPathSample {
    return buildSample(mapping, null, { now: 0, staleAfterSeconds: this.staleAfterSeconds, source: 'disabled', synthetic: false });
  }

  async getNetworkPaths(): Promise<NetworkPathSample[]> {
    return this.mappings.map((m) => this.sample(m));
  }

  async getNetworkPath(pathId: string): Promise<NetworkPathSample | null> {
    const mapping = this.mappings.find((m) => m.id === pathId);
    return mapping ? this.sample(mapping) : null;
  }
}

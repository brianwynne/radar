// Deterministic mock Touchstream client. Needs no credentials, so mock mode is safe in CI, in the
// dev stack and in a demo. Scenarios cover the failure classes the adapter must handle.
import { TouchstreamError, type TouchstreamClient, type TouchstreamStatsQuery } from './client.js';
import {
  ERRORS,
  LOCATION_GROUPS,
  STATS,
  STREAMS_DEGRADED,
  STREAMS_INCOMPARABLE,
  STREAMS_MISLABELLED,
  STREAMS_NORMAL,
} from './fixtures.js';
import type { TsError, TsLocationGroup, TsStat, TsStreamFull } from './wire.js';

export type TouchstreamScenario =
  | 'normal'
  | 'mislabelled'
  | 'incomparable'
  | 'degraded'
  | 'empty'
  | 'auth-failure'
  | 'unavailable';

const STREAMS: Record<string, TsStreamFull[]> = {
  normal: STREAMS_NORMAL,
  mislabelled: STREAMS_MISLABELLED,
  incomparable: STREAMS_INCOMPARABLE,
  degraded: STREAMS_DEGRADED,
  empty: [],
};

export interface MockTouchstreamOptions {
  scenario?: TouchstreamScenario;
}

export class MockTouchstreamClient implements TouchstreamClient {
  private readonly scenario: TouchstreamScenario;

  constructor(opts: MockTouchstreamOptions = {}) {
    this.scenario = opts.scenario ?? 'normal';
  }

  private guard(): void {
    if (this.scenario === 'auth-failure') {
      throw new TouchstreamError(
        'Touchstream rejected the credentials. Both the X-TS-ID app id and the bearer token are required.',
        'TOUCHSTREAM_AUTH',
        403,
      );
    }
    if (this.scenario === 'unavailable') {
      throw new TouchstreamError('Touchstream is unreachable.', 'TOUCHSTREAM_UNAVAILABLE');
    }
  }

  async fetchStreams(): Promise<TsStreamFull[]> {
    this.guard();
    return STREAMS[this.scenario] ?? STREAMS_NORMAL;
  }

  async fetchLocationGroups(): Promise<(TsLocationGroup | null)[]> {
    this.guard();
    return LOCATION_GROUPS;
  }

  async fetchStats(_query: TouchstreamStatsQuery): Promise<TsStat[]> {
    this.guard();
    return this.scenario === 'empty' ? [] : STATS;
  }

  async fetchErrors(_query: TouchstreamStatsQuery): Promise<TsError[]> {
    this.guard();
    return this.scenario === 'empty' || this.scenario === 'normal' ? [] : ERRORS;
  }
}

// Read-only Touchstream client contract. GET-only by construction: there is no method here that
// could mutate Touchstream state, even though the vendor API exposes write endpoints.
import type { TsError, TsLocationGroup, TsStat, TsStreamFull } from './wire.js';

export interface TouchstreamStatsQuery {
  environment: 'PROD' | 'NPROD';
  startEpochSeconds: number;
  endEpochSeconds: number;
}

export interface TouchstreamClient {
  /** `/api/stream_status_full/` — every monitored stream with its per-location detail. */
  fetchStreams(): Promise<TsStreamFull[]>;
  /** `/api/location_detail/` — probe location groups (supplier/country/region per code). */
  fetchLocationGroups(): Promise<(TsLocationGroup | null)[]>;
  /** `/api/stream_stats/{env}/{start}/{end}/` — per CDN+format aggregates over a window. */
  fetchStats(query: TouchstreamStatsQuery): Promise<TsStat[]>;
  /** `/api/error_log/{env}/{start}/{end}/` — individual failures over a window. */
  fetchErrors(query: TouchstreamStatsQuery): Promise<TsError[]>;
}

export class TouchstreamError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'TOUCHSTREAM_AUTH'
      | 'TOUCHSTREAM_UNAVAILABLE'
      | 'TOUCHSTREAM_INVALID_RESPONSE'
      | 'TOUCHSTREAM_TIMEOUT',
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'TouchstreamError';
  }
}

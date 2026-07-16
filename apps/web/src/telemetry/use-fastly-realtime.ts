// Load the Fastly real-time (per-second) live-tail: a short rolling window of one-second delivery
// samples per service. Polls faster than the historical view (the server already long-polls Fastly;
// this just re-reads the accumulated ring buffer). Informational only; gaps/nulls are never invented.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { FastlyProvenance, FastlyRealtimeSeries, FastlySource } from '../api/types';

export interface FastlyRealtimeState {
  source: FastlySource | null;
  provenance: FastlyProvenance | null;
  windowSeconds: number;
  series: FastlyRealtimeSeries[];
  warnings: string[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
}

export function useFastlyRealtime(refreshMs = 2000): FastlyRealtimeState {
  const [state, setState] = useState<FastlyRealtimeState>({
    source: null, provenance: null, windowSeconds: 0, series: [], warnings: [], loading: true, error: null, lastLoadedAt: null,
  });

  const load = useCallback(async () => {
    try {
      const r = await api.fastlyRealtime();
      setState({ source: r.source, provenance: r.provenance, windowSeconds: r.windowSeconds, series: r.series ?? [], warnings: r.warnings ?? [], loading: false, error: null, lastLoadedAt: Date.now() });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'Fastly real-time telemetry unavailable.', lastLoadedAt: Date.now() }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load]);

  return state;
}

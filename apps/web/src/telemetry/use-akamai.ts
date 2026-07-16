// Load the Akamai per-CP-code realtime telemetry (DataStream 2 edge logs aggregated by RADAR).
// Informational only; a missing value is never invented. Polls a few seconds — DS2 delivers with
// ~minute latency, so faster polling gains nothing.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { AkamaiProvenance, AkamaiSeries, AkamaiSource } from '../api/types';

export interface AkamaiState {
  source: AkamaiSource | null;
  provenance: AkamaiProvenance | null;
  windowSeconds: number;
  series: AkamaiSeries[];
  warnings: string[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
}

export function useAkamai(refreshMs = 5000): AkamaiState {
  const [state, setState] = useState<AkamaiState>({
    source: null, provenance: null, windowSeconds: 0, series: [], warnings: [], loading: true, error: null, lastLoadedAt: null,
  });

  const load = useCallback(async () => {
    try {
      const r = await api.akamaiRealtime();
      setState({ source: r.source, provenance: r.provenance, windowSeconds: r.windowSeconds, series: r.series ?? [], warnings: r.warnings ?? [], loading: false, error: null, lastLoadedAt: Date.now() });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'Akamai telemetry unavailable.', lastLoadedAt: Date.now() }));
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

// Load read-only Fastly CDN observability state: connector status + summary and per-service
// delivery telemetry. Informational only; a missing value is never invented. Mirrors use-cloudflare.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { FastlyConnectorStatus, FastlyProvenance, FastlyServiceStats, FastlySummary } from '../api/types';

export interface FastlyState {
  status: FastlyConnectorStatus | null;
  summary: FastlySummary | null;
  provenance: FastlyProvenance | null;
  services: FastlyServiceStats[];
  warnings: string[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  refreshMs: number;
  refresh: () => void;
}

export function useFastly(refreshMs?: number): FastlyState {
  const [state, setState] = useState<Omit<FastlyState, 'refresh' | 'refreshMs'>>({
    status: null, summary: null, provenance: null, services: [], warnings: [], loading: true, error: null, lastLoadedAt: null,
  });

  const load = useCallback(async () => {
    try {
      const [status, services] = await Promise.all([api.fastlyStatus(), api.fastlyServices()]);
      setState({
        status: status.status, summary: status.summary, provenance: status.provenance, warnings: status.warnings ?? [],
        services: services.items ?? [], loading: false, error: null, lastLoadedAt: Date.now(),
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'Fastly CDN telemetry unavailable.', lastLoadedAt: Date.now() }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load]);

  return { ...state, refreshMs: refreshMs ?? 0, refresh: () => void load() };
}

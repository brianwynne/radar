// Load read-only network-path telemetry once (with an optional refresh interval). Shared by
// the Dashboard, Delivery Topology and Live Steering. Telemetry is informational only.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { NetworkPathSample, TelemetrySource } from '../api/types';

export interface NetworkPathsState {
  paths: NetworkPathSample[];
  byName: Map<string, NetworkPathSample>;
  mode: TelemetrySource | null;
  notice: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useNetworkPaths(refreshMs?: number): NetworkPathsState {
  const [paths, setPaths] = useState<NetworkPathSample[]>([]);
  const [mode, setMode] = useState<TelemetrySource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.telemetryNetworkPaths();
      setPaths(res.items ?? []);
      setMode(res.provenance?.telemetryMode ?? null);
      setNotice(res.provenance?.notice ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Telemetry unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load]);

  return { paths, byName: new Map(paths.map((p) => [p.pathName, p])), mode, notice, loading, error, refresh: () => void load() };
}

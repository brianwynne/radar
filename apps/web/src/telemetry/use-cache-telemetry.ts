// Load read-only Réalta cache-pool / cache-node / origin telemetry. Shared by the Dashboard,
// Delivery Topology and Live Steering. Informational only.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { CacheNodeSample, CachePoolSample, OriginSample, TelemetrySource } from '../api/types';

export interface CacheTelemetryState {
  pools: CachePoolSample[];
  nodes: CacheNodeSample[];
  origin: OriginSample | null;
  mode: TelemetrySource | null;
  notice: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCacheTelemetry(opts: { includeNodes?: boolean; refreshMs?: number } = {}): CacheTelemetryState {
  const { includeNodes = false, refreshMs } = opts;
  const [pools, setPools] = useState<CachePoolSample[]>([]);
  const [nodes, setNodes] = useState<CacheNodeSample[]>([]);
  const [origin, setOrigin] = useState<OriginSample | null>(null);
  const [mode, setMode] = useState<TelemetrySource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [poolRes, originRes, nodeRes] = await Promise.all([
        api.telemetryCachePools(),
        api.telemetryOrigin(),
        includeNodes ? api.telemetryCacheNodes() : Promise.resolve(null),
      ]);
      setPools(poolRes.items ?? []);
      setOrigin(originRes.item ?? null);
      if (nodeRes) setNodes(nodeRes.items ?? []);
      setMode(poolRes.provenance?.telemetryMode ?? null);
      setNotice(poolRes.provenance?.notice ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Cache telemetry unavailable.');
    } finally {
      setLoading(false);
    }
  }, [includeNodes]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load]);

  return { pools, nodes, origin, mode, notice, loading, error, refresh: () => void load() };
}

// Load read-only Réalta cache load-balancing (Cloudflare) state: connector status + summary,
// load balancers (steering) and pools (origins/health). Informational only; a missing value is
// never invented. Mirrors use-cloudvision.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { CloudflareConnectorStatus, CloudflareLoadBalancer, CloudflarePool, CloudflareProvenance, CloudflareSummary } from '../api/types';

export interface CloudflareState {
  status: CloudflareConnectorStatus | null;
  summary: CloudflareSummary | null;
  provenance: CloudflareProvenance | null;
  loadBalancers: CloudflareLoadBalancer[];
  pools: CloudflarePool[];
  warnings: string[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  refreshMs: number;
  refresh: () => void;
}

export function useCloudflare(refreshMs?: number): CloudflareState {
  const [state, setState] = useState<Omit<CloudflareState, 'refresh' | 'refreshMs'>>({
    status: null, summary: null, provenance: null, loadBalancers: [], pools: [], warnings: [], loading: true, error: null, lastLoadedAt: null,
  });

  const load = useCallback(async () => {
    try {
      const [status, lbs, pools] = await Promise.all([api.cloudflareStatus(), api.cloudflareLoadBalancers(), api.cloudflarePools()]);
      setState({
        status: status.status, summary: status.summary, provenance: status.provenance, warnings: status.warnings ?? [],
        loadBalancers: lbs.items ?? [], pools: pools.items ?? [], loading: false, error: null, lastLoadedAt: Date.now(),
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'Réalta cache load-balancing unavailable.', lastLoadedAt: Date.now() }));
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

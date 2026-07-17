// Fast tier for the Load Balancing page: live-refresh just the pinned pools' health + RTT on a short
// interval, while the full snapshot stays on the slower poll. The server hard-caps how many pools it
// will fetch per call, so this can poll fast without risking Cloudflare's API rate limits. Read-only.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CloudflareFocusedPoolHealth } from '../api/types';

export interface CloudflareFocusedState {
  byId: Map<string, CloudflareFocusedPoolHealth>;
  /** True when more pools were requested than the server will fast-refresh (the extras stay on the slow poll). */
  capped: boolean;
  lastLoadedAt: number | null;
}

export function useCloudflareFocused(poolIds: string[], refreshMs = 10_000): CloudflareFocusedState {
  const [state, setState] = useState<CloudflareFocusedState>({ byId: new Map(), capped: false, lastLoadedAt: null });
  // Stable dependency key so re-renders with a new array reference don't re-fire the effect.
  const idsKey = [...poolIds].sort().join(',');

  const load = useCallback(async () => {
    const ids = idsKey ? idsKey.split(',') : [];
    if (ids.length === 0) { setState({ byId: new Map(), capped: false, lastLoadedAt: Date.now() }); return; }
    try {
      const r = await api.cloudflareRefreshPools(ids);
      setState({ byId: new Map((r.pools ?? []).map((p) => [p.id, p])), capped: !!r.capped, lastLoadedAt: Date.now() });
    } catch { /* best-effort — keep the last fast values */ }
  }, [idsKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!refreshMs || idsKey.length === 0) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load, idsKey]);

  return state;
}

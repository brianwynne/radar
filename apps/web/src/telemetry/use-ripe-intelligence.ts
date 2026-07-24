// Load read-only RIPE BGP intelligence (route-visibility snapshot + source health + RIS Live event
// timeline). Informational only; missing RIPE data is surfaced as unknown, never a withdrawal.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { RisEvent, RipeSourceHealth, RouteVisibilitySnapshot } from '../api/types';

export interface RipeIntelligenceState {
  snapshot: RouteVisibilitySnapshot | null;
  source: RipeSourceHealth | null;
  events: RisEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useRipeIntelligence(intervalMs = 20000): RipeIntelligenceState {
  const [snapshot, setSnapshot] = useState<RouteVisibilitySnapshot | null>(null);
  const [source, setSource] = useState<RipeSourceHealth | null>(null);
  const [events, setEvents] = useState<RisEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [snap, ev] = await Promise.all([api.ripeSnapshot(), api.ripeEvents({ limit: 200 })]);
      setSnapshot(snap.snapshot);
      setSource(snap.source);
      setEvents(ev.items);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load RIPE BGP intelligence.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!intervalMs) return undefined;
    const id = setInterval(() => void load(), intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs]);

  return { snapshot, source, events, loading, error, refresh: () => void load() };
}

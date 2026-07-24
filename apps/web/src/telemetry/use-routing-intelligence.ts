// Load read-only bgp.tools routing intelligence (snapshot + connector status + incidents) with a
// refresh interval. Informational only; a missing value is never invented.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { RoutingConnectionDiagnostic, RoutingIncident, RoutingSnapshot, RoutingStatus } from '../api/types';

export interface RoutingIntelligenceState {
  status: RoutingStatus | null;
  snapshot: RoutingSnapshot | null;
  connection: RoutingConnectionDiagnostic | null;
  incidents: RoutingIncident[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useRoutingIntelligence(intervalMs = 15000): RoutingIntelligenceState {
  const [status, setStatus] = useState<RoutingStatus | null>(null);
  const [snapshot, setSnapshot] = useState<RoutingSnapshot | null>(null);
  const [connection, setConnection] = useState<RoutingConnectionDiagnostic | null>(null);
  const [incidents, setIncidents] = useState<RoutingIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [snap, inc] = await Promise.all([api.routingSnapshot(), api.routingIncidents({ limit: 100 })]);
      setStatus(snap.status);
      setSnapshot(snap.snapshot);
      setConnection(snap.connection ?? null);
      setIncidents(inc.items);
      setError(null);
    } catch (e) {
      // 503 = connector not configured; surface a friendly message rather than an error state.
      setError(e instanceof ApiError ? e.message : 'Failed to load routing intelligence.');
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

  return { status, snapshot, connection, incidents, loading, error, refresh: () => void load() };
}

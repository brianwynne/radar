// Load Tier-2 DNS observation config + latest state, expose a manual run, and detect
// per-ISP observation changes (for the observed-DNS highlight — distinct from a steering
// change). Read-only; a single observation is one sample, never proof of traffic.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { DnsObservationItem, DnsTierLabels } from '../api/types';

export interface DnsObservationSnapshot {
  comparisonStatus: string;
  confidence: string;
  resolverIp?: string;
  ecsHonoured?: boolean;
  ttl?: number;
  answers: string;
}

const AVAILABLE = (s: string) => s !== 'observation_unavailable';

/** Client-side mirror of the backend reason classification (for the highlight label). */
export function classifyChange(prev: DnsObservationSnapshot, curr: DnsObservationSnapshot): string {
  if (AVAILABLE(prev.comparisonStatus) && !AVAILABLE(curr.comparisonStatus)) return 'observation_became_unavailable';
  if (!AVAILABLE(prev.comparisonStatus) && AVAILABLE(curr.comparisonStatus)) return 'observation_recovered';
  if (prev.answers !== curr.answers) return 'observed_answer_set_changed';
  if (prev.comparisonStatus !== curr.comparisonStatus) return 'predicted_observed_match_changed';
  if ((prev.ecsHonoured ?? null) !== (curr.ecsHonoured ?? null)) return 'ecs_behaviour_changed';
  if ((prev.resolverIp ?? '') !== (curr.resolverIp ?? '')) return 'resolver_changed';
  if ((prev.ttl ?? null) !== (curr.ttl ?? null)) return 'ttl_changed';
  if (prev.confidence !== curr.confidence) return 'confidence_changed';
  return 'unknown_change';
}

const snapshotOf = (o: DnsObservationItem): DnsObservationSnapshot => ({
  comparisonStatus: o.comparisonStatus,
  confidence: o.confidence,
  resolverIp: o.resolverIp,
  ecsHonoured: o.ecsHonoured,
  ttl: o.ttl,
  answers: o.observedAnswers.map((a) => a.address).slice().sort().join(','),
});

export interface DnsObservationState {
  mode: 'disabled' | 'mock' | 'resolver' | null;
  tierLabels: DnsTierLabels | null;
  byIsp: Map<string, DnsObservationItem | null>;
  changedAt: Map<string, number>;
  changeReason: Map<string, string>;
  loading: boolean;
  error: string | null;
  running: boolean;
  run: (ispId?: string) => void;
  refresh: () => void;
}

const HIGHLIGHT_MS = 10_000;

export function useDnsObservation(opts: { refreshMs?: number } = {}): DnsObservationState {
  const [mode, setMode] = useState<DnsObservationState['mode']>(null);
  const [tierLabels, setTierLabels] = useState<DnsTierLabels | null>(null);
  const [byIsp, setByIsp] = useState<Map<string, DnsObservationItem | null>>(new Map());
  const [changedAt, setChangedAt] = useState<Map<string, number>>(new Map());
  const [changeReason, setChangeReason] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const snapshots = useRef<Map<string, DnsObservationSnapshot>>(new Map());
  const primed = useRef(false);

  const applyState = useCallback((items: { ispId: string; observation: DnsObservationItem | null }[]) => {
    const nextByIsp = new Map<string, DnsObservationItem | null>();
    const highlights = new Map<string, number>();
    const reasons = new Map<string, string>();
    const at = Date.now();
    for (const { ispId, observation } of items) {
      nextByIsp.set(ispId, observation);
      if (!observation) continue;
      const snap = snapshotOf(observation);
      const prev = snapshots.current.get(ispId);
      if (primed.current && prev && (prev.comparisonStatus !== snap.comparisonStatus || prev.answers !== snap.answers || (prev.ecsHonoured ?? null) !== (snap.ecsHonoured ?? null) || (prev.resolverIp ?? '') !== (snap.resolverIp ?? '') || (prev.ttl ?? null) !== (snap.ttl ?? null) || prev.confidence !== snap.confidence)) {
        highlights.set(ispId, at);
        reasons.set(ispId, classifyChange(prev, snap));
      }
      snapshots.current.set(ispId, snap);
    }
    primed.current = true;
    setByIsp(nextByIsp);
    if (highlights.size > 0) {
      setChangedAt((prev) => new Map([...prev, ...highlights]));
      setChangeReason((prev) => new Map([...prev, ...reasons]));
    }
  }, []);

  const loadState = useCallback(async () => {
    try {
      const res = await api.dnsObservationState();
      setTierLabels(res.tierLabels ?? null);
      applyState(res.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'DNS observation unavailable.');
    } finally {
      setLoading(false);
    }
  }, [applyState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.dnsObservationConfig();
        if (!cancelled) {
          setMode(cfg.mode);
          setTierLabels(cfg.tierLabels);
        }
      } catch {
        // config is best-effort; state load still proceeds
      }
      if (!cancelled) await loadState();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadState]);

  useEffect(() => {
    if (!opts.refreshMs) return;
    const t = setInterval(() => void loadState(), opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, loadState]);

  const run = useCallback(
    (ispId?: string) => {
      setRunning(true);
      void (async () => {
        try {
          await api.dnsObservationRun(ispId);
          await loadState();
        } catch (e) {
          setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'DNS observation run failed.');
        } finally {
          setRunning(false);
        }
      })();
    },
    [loadState],
  );

  // Expire highlights after the window.
  const [, force] = useState(0);
  useEffect(() => {
    if (changedAt.size === 0) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [changedAt]);
  const now = Date.now();
  const activeHighlights = new Map([...changedAt].filter(([, at]) => now - at < HIGHLIGHT_MS));

  return { mode, tierLabels, byIsp, changedAt: activeHighlights, changeReason, loading, error, running, run, refresh: () => void loadState() };
}

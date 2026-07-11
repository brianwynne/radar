// Live Steering — the primary operational view. It shows the CURRENT EXPECTED DNS steering
// per ISP: the deterministic result of RADAR evaluating the current NS1 Filter Chain,
// persisted server-side by the change-detection service. This is EXPECTED steering derived
// from configuration — NOT measured traffic.
//
// The page loads the configured ISP scenarios and the latest persisted state, then polls
// ONLY /live-steering/events. An ISP card refreshes (and briefly highlights) only when a
// relevant, meaningful steering-change event arrives. Random Weighted-Shuffle ordering and
// timestamp-only churn never produce an event (that is enforced server-side by the stable
// fingerprint), so the page never highlights a non-change.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useNetworkPaths } from '../telemetry/use-network-paths';
import { PathTelemetryInline } from '../telemetry/NetworkPathTelemetry';
import type { LiveSteeringConfig, LiveSteeringEvent, LiveSteeringState } from '../api/types';

const DEFAULT_INTERVAL = 30;
const RECENT_LIMIT = 25;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Eligible delivery platforms for display: prefer the distribution's human labels, fall
 *  back to the raw eligible answer ids (e.g. for a partial evaluation with no distribution). */
function eligiblePlatforms(s: LiveSteeringState): string[] {
  return s.eligibleAnswerIds.map((id) => {
    const share = s.distribution.find((d) => d.answerId === id);
    return share?.deliveryPlatform ?? share?.label ?? id;
  });
}

const summarise = (s: LiveSteeringState): string => {
  const plats = eligiblePlatforms(s).join(', ') || '—';
  const dist = s.distribution.map((d) => `${d.deliveryPlatform ?? d.label} ${(d.share * 100).toFixed(0)}%`).join(', ');
  return dist ? `${plats} (${dist})` : plats;
};

interface CardState {
  state?: LiveSteeringState;
  error?: string;
  changedAt?: number;
  lastEvent?: LiveSteeringEvent;
}

export function LiveSteering() {
  const { hasPermission } = useAuth();
  const canView = hasPermission('steering.summary.read');
  const showDetail = hasPermission('ns1.detail.read');
  const reduceMotion = useMemo(prefersReducedMotion, []);
  const telemetry = useNetworkPaths(60_000); // read-only, informational; refreshed hourly-ish

  const [config, setConfig] = useState<LiveSteeringConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [intervalSec, setIntervalSec] = useState(DEFAULT_INTERVAL);
  const [paused, setPaused] = useState(false);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [events, setEvents] = useState<LiveSteeringEvent[]>([]);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const highlightMs = (config?.highlightSeconds ?? 10) * 1000;
  const maxSel = config?.maxSelectableIsps ?? 6;

  // Cursor: the occurredAt of the newest event already seen. Events are only "new" (and thus
  // highlight-worthy) if strictly after this. Held in a ref so polling reads the latest value
  // without re-subscribing the interval. `primed` guards against highlighting the backlog of
  // events that already existed when the page first loaded.
  const cursorRef = useRef<string | null>(null);
  const primedRef = useRef(false);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Load config once, then seed the initial selection and interval from it.
  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.liveSteeringConfig();
        if (cancelled) return;
        setConfig(cfg);
        setIntervalSec(cfg.defaultPollIntervalSeconds);
        setSelected(cfg.isps.slice(0, 2).map((i) => i.id));
      } catch (e) {
        if (!cancelled) setConfigError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load Live Steering configuration.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < maxSel ? [...s, id] : s));

  // Load persisted state for any selected ISP that does not yet have one. Per-ISP so a
  // single failing ISP is isolated and does not blank the others.
  const loadState = useCallback(async (ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await api.liveSteeringState({ isp: id });
          const state = res.items[0];
          setCards((prev) => ({ ...prev, [id]: { ...prev[id], state, error: undefined } }));
        } catch (e) {
          setCards((prev) => ({ ...prev, [id]: { ...prev[id], error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'State unavailable.' } }));
        }
      }),
    );
  }, []);

  useEffect(() => {
    if (!canView) return;
    const missing = selected.filter((id) => cards[id] === undefined);
    if (missing.length > 0) void loadState(missing);
  }, [canView, selected, cards, loadState]);

  // Poll ONLY the events endpoint. On the first poll we prime the cursor from the backlog
  // WITHOUT highlighting (so a reload never re-highlights old changes). Thereafter, each new
  // event that targets a currently-selected ISP refreshes that card from the event's own
  // persisted currentState and highlights it.
  const pollEvents = useCallback(async () => {
    try {
      const since = cursorRef.current ?? undefined;
      const res = await api.liveSteeringEvents(since ? { since, limit: RECENT_LIMIT } : { limit: RECENT_LIMIT });
      const fresh = res.items; // newest first
      if (fresh.length > 0) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const merged = [...fresh.filter((e) => !seen.has(e.id)), ...prev];
          return merged.slice(0, RECENT_LIMIT);
        });
        const newestSeen = cursorRef.current;
        cursorRef.current = fresh[0].occurredAt;
        if (primedRef.current) {
          const applied = new Set<string>();
          const at = Date.now();
          for (const ev of fresh) {
            if (newestSeen && ev.occurredAt <= newestSeen) continue; // defensive: only strictly newer
            if (!selectedRef.current.includes(ev.ispId)) continue; // unaffected ISP: no refresh, no highlight
            if (applied.has(ev.ispId)) continue; // keep only the most recent per ISP
            applied.add(ev.ispId);
            setCards((prev) => ({ ...prev, [ev.ispId]: { ...prev[ev.ispId], state: ev.currentState, error: undefined, changedAt: at, lastEvent: ev } }));
          }
        }
      }
      primedRef.current = true;
      setPollError(null);
      setLastPollAt(Date.now());
    } catch (e) {
      setPollError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Event polling failed.');
    }
  }, []);

  // Initial events load (primes the cursor + Recent panel) once config is available.
  useEffect(() => {
    if (!canView || !config) return;
    void pollEvents();
  }, [canView, config, pollEvents]);

  // Repeat on the chosen interval unless paused.
  useEffect(() => {
    if (paused || !canView || !config) return;
    const t = setInterval(() => void pollEvents(), intervalSec * 1000);
    return () => clearInterval(t);
  }, [paused, canView, config, intervalSec, pollEvents]);

  // A slow ticker to expire the highlight and drive the stale indicator.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshNow = useCallback(() => {
    void loadState(selectedRef.current);
    void pollEvents();
  }, [loadState, pollEvents]);

  const staleAfter = intervalSec * 2 * 1000;
  const stale = pollError !== null || (lastPollAt !== null && now - lastPollAt > staleAfter);

  if (!canView) {
    return (
      <div>
        <div className="page-head">
          <h1>Current Expected DNS Steering</h1>
        </div>
        <div className="notice info">Live evaluation requires the Viewing Engineer role, or NOC steering-summary access.</div>
      </div>
    );
  }

  const isps = config?.isps ?? [];

  return (
    <div className={reduceMotion ? 'reduce-motion' : ''}>
      <div className="page-head">
        <h1>Current Expected DNS Steering</h1>
        <p>
          The delivery platform NS1 is <b>expected</b> to steer each ISP to, from the current NS1 configuration RADAR has
          captured. This is <b>expected steering derived from configuration — not measured traffic.</b>
        </p>
      </div>

      {configError && <div className="notice danger">{configError}</div>}
      {telemetry.notice && telemetry.mode !== 'disabled' && <div className="notice info">{telemetry.notice}</div>}

      <div className="card">
        <div className="isp-picker">
          {isps.map((isp) => {
            const on = selected.includes(isp.id);
            return (
              <label key={isp.id} className={on ? 'on' : ''}>
                <input type="checkbox" checked={on} disabled={!on && selected.length >= maxSel} onChange={() => toggle(isp.id)} />
                {isp.name} <span className="mono muted">AS{isp.asn}</span>
              </label>
            );
          })}
        </div>
        <div className="live-controls">
          <button className="ghost" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          <button className="ghost" onClick={refreshNow}>Refresh now</button>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.3rem' }}>
            Every
            <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}>
              {(config?.pollIntervalsSeconds ?? [15, 30, 60]).map((s) => (
                <option key={s} value={s}>{s}s</option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {paused && <span className="badge warn">paused</span>}
          {stale && <span className="badge danger">stale</span>}
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {lastPollAt ? `Last update ${new Date(lastPollAt).toLocaleTimeString()}` : 'No update yet'}
          </span>
        </div>
      </div>

      {isps
        .filter((i) => selected.includes(i.id))
        .map((isp) => {
          const c = cards[isp.id];
          const s = c?.state;
          const highlighted = c?.changedAt !== undefined && now - c.changedAt < highlightMs;
          const cls = `isp-card${highlighted ? (reduceMotion ? ' changed no-animate' : ' changed') : ''}${c?.error ? ' error' : ''}`;
          return (
            <div key={isp.id} className={cls}>
              <div className="step-head">
                <h3 style={{ margin: 0 }}>
                  {isp.name} <span className="mono muted">AS{isp.asn}</span>
                </h3>
                {highlighted && <span className="badge info">changed</span>}
                {s && !c?.error && (s.complete ? <span className="badge ok">complete</span> : <span className="badge warn">partial</span>)}
              </div>

              {c?.error ? (
                <div className="notice danger">{c.error}</div>
              ) : !s ? (
                <span className="muted">No persisted steering state yet.</span>
              ) : (
                <>
                  <div className="path">
                    <div className="seg"><span className="seg-label">ISP / ASN</span>{isp.name} AS{isp.asn}</div>
                    <div className="seg"><span className="seg-label">Identity source</span>{s.identitySource ?? '—'}</div>
                    <div className="seg"><span className="seg-label">NS1 steering result</span>{s.filterChain.join(' → ') || '—'}</div>
                    <div className="seg"><span className="seg-label">Eligible platforms</span>{eligiblePlatforms(s).join(', ') || '—'}</div>
                    <div className="seg"><span className="seg-label">Expected DNS distribution</span>{s.complete ? s.distribution.map((d) => `${d.deliveryPlatform ?? d.label} ${(d.share * 100).toFixed(0)}%`).join(' · ') || '—' : '— (partial)'}</div>
                    <div className="seg realta"><span className="seg-label">Preferred Réalta path</span>{s.preferredPath ?? isp.preferredPath} <span className="badge neutral">CONFIGURED</span></div>
                    <div className="seg cloudflare"><span className="seg-label">Downstream</span>Cloudflare Load Balancer</div>
                  </div>
                  {(() => {
                    const sample = telemetry.byName.get(s.preferredPath ?? isp.preferredPath ?? '');
                    return sample ? <PathTelemetryInline sample={sample} detail={showDetail} /> : null;
                  })()}
                  <div className="muted" style={{ fontSize: '0.76rem', marginTop: '0.4rem' }}>
                    Actual CDN traffic share: <b>Telemetry not connected</b> · evaluated {new Date(s.evaluatedAt).toLocaleTimeString()}
                    {!s.complete && ' · partial evaluation — no definitive platform'}
                  </div>
                  {highlighted && c?.lastEvent && (
                    <div className="notice info" style={{ marginTop: '0.4rem' }}>
                      <b>Steering changed.</b> {c.lastEvent.reasonLabel}. {c.lastEvent.previousState ? `Previous: ${summarise(c.lastEvent.previousState)} → now: ${summarise(s)}.` : `Now: ${summarise(s)}.`}
                      {' '}
                      <span className="mono muted">checksum {c.lastEvent.previousChecksum ?? '—'} → {c.lastEvent.currentChecksum ?? '—'}</span>
                      {' · '}
                      <span className="muted">{new Date(c.lastEvent.occurredAt).toLocaleTimeString()}</span>
                    </div>
                  )}
                  {showDetail && (
                    <details style={{ marginTop: '0.4rem' }}>
                      <summary className="muted">Fingerprint</summary>
                      <div className="mono muted" style={{ fontSize: '0.74rem', wordBreak: 'break-all' }}>{s.fingerprint}</div>
                    </details>
                  )}
                </>
              )}
            </div>
          );
        })}

      <div className="card">
        <h3>Recent Steering Changes</h3>
        {events.length === 0 ? (
          <div className="muted">No steering changes observed.</div>
        ) : (
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr><th>Time</th><th>ISP</th><th>Reason</th><th>Previous → Current</th></tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.occurredAt).toLocaleTimeString()}</td>
                    <td>{e.ispName}</td>
                    <td>{e.reasonLabel}</td>
                    <td className="muted">{e.previousState ? summarise(e.previousState) : '—'} → {summarise(e.currentState)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

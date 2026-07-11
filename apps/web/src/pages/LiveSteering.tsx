// Live Steering — the primary operational view. For each selected ISP, RADAR repeatedly
// evaluates the CURRENT NS1 configuration via /api/v1/dns/explain and shows the *expected*
// DNS steering path. This is EXPECTED steering derived from configuration — NOT measured
// traffic. Stable fingerprinting means only meaningful changes (eligible answers,
// distribution, completeness, identity source, preferred path) trigger a highlight; random
// Weighted-Shuffle ordering is deliberately ignored.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { networkPathForAsn } from '../topology/model';
import type { EvaluationResult, ExplainRequest } from '../api/types';

interface Isp {
  id: string;
  name: string;
  asn: number;
  ecsPrefix: string;
}

// Synthetic ASNs/prefixes for the mock — illustrative, not authoritative routing data.
const ISPS: Isp[] = [
  { id: 'eir', name: 'Eir', asn: 5466, ecsPrefix: '185.2.100.0/24' },
  { id: 'virgin', name: 'Virgin Media', asn: 6830, ecsPrefix: '80.233.0.0/24' },
  { id: 'vodafone', name: 'Vodafone', asn: 15502, ecsPrefix: '109.76.0.0/24' },
  { id: 'three', name: 'Three', asn: 34218, ecsPrefix: '37.228.0.0/24' },
  { id: 'sky', name: 'Sky', asn: 5607, ecsPrefix: '2.216.0.0/24' },
  { id: 'digiweb', name: 'Digiweb', asn: 15919, ecsPrefix: '89.19.0.0/24' },
];
const MAX_SELECTED = 6;
const INTERVALS = [15, 30, 60];

interface SteerState {
  fingerprint: string;
  source: string;
  eligiblePlatforms: string[];
  distribution: { label: string; share: number }[];
  complete: boolean;
  unsupportedFilters: string[];
  chain: string[];
  preferredPath: string;
  evaluation: EvaluationResult;
  lastUpdated: number;
  changedAt?: number;
  previous?: SteerState;
  error?: string;
}

interface ChangeEntry {
  isp: string;
  at: number;
  reason: string;
  from: string;
  to: string;
}

const requestFor = (isp: Isp): ExplainRequest => ({
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  type: 'A',
  scenario: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: isp.ecsPrefix, country: 'IE', asn: isp.asn },
});

function fingerprint(ev: EvaluationResult, preferredPath: string): string {
  const eligible = [...ev.eligibleAnswerIds].sort().join(',');
  // Expected shares are deterministic (weights); the *ordering* from Weighted Shuffle is
  // random and intentionally excluded.
  const dist = (ev.expectedDistribution?.shares ?? []).map((s) => `${s.answerId}:${s.share.toFixed(3)}`).sort().join('|');
  const unsupported = [...ev.unsupportedFilters].sort().join(',');
  return [ev.identity.source, eligible, dist, ev.complete, unsupported, preferredPath].join('||');
}

function parseState(ev: EvaluationResult, isp: Isp): SteerState {
  const eligiblePlatforms = ev.eligibleAnswerIds.map((id) => ev.answers.find((a) => a.id === id)?.deliveryPlatform ?? id);
  const distribution = (ev.expectedDistribution?.shares ?? []).map((s) => ({ label: s.deliveryPlatform ?? s.label, share: s.share }));
  const preferredPath = networkPathForAsn(isp.asn).label;
  return {
    fingerprint: fingerprint(ev, preferredPath),
    source: ev.identity.source,
    eligiblePlatforms,
    distribution,
    complete: ev.complete,
    unsupportedFilters: ev.unsupportedFilters,
    chain: ev.traces.map((t) => t.type),
    preferredPath,
    evaluation: ev,
    lastUpdated: Date.now(),
  };
}

function reasonFor(prev: SteerState, curr: SteerState): string {
  const out: string[] = [];
  if (prev.eligiblePlatforms.join(',') !== curr.eligiblePlatforms.join(',')) out.push(`Eligible platforms: ${prev.eligiblePlatforms.join(', ') || '—'} → ${curr.eligiblePlatforms.join(', ') || '—'}`);
  if (prev.source !== curr.source) out.push(`Identity source: ${prev.source} → ${curr.source}`);
  if (prev.complete !== curr.complete) out.push(curr.complete ? 'Evaluation now complete' : 'Evaluation now partial');
  const pd = prev.distribution.map((d) => `${d.label} ${(d.share * 100).toFixed(0)}%`).join(', ');
  const cd = curr.distribution.map((d) => `${d.label} ${(d.share * 100).toFixed(0)}%`).join(', ');
  if (pd !== cd) out.push('Expected distribution changed');
  return out.join('; ') || 'Steering state changed';
}

const summarise = (s: SteerState) => `${s.eligiblePlatforms.join(', ') || '—'} (${s.distribution.map((d) => `${d.label} ${(d.share * 100).toFixed(0)}%`).join(', ') || 'n/a'})`;

export function LiveSteering() {
  const { hasPermission } = useAuth();
  const canEvaluate = hasPermission('dns.explain.read'); // NOC has steering.summary.read but not this
  const showDetail = hasPermission('ns1.detail.read');

  const [selected, setSelected] = useState<string[]>(['eir', 'virgin']);
  const [intervalSec, setIntervalSec] = useState(30);
  const [paused, setPaused] = useState(false);
  const [states, setStates] = useState<Record<string, SteerState>>({});
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const statesRef = useRef(states);
  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_SELECTED ? [...s, id] : s));

  const evaluateAll = useCallback(async () => {
    if (!canEvaluate) return;
    const isps = ISPS.filter((i) => selected.includes(i.id));
    await Promise.all(
      isps.map(async (isp) => {
        try {
          const res = await api.explain(requestFor(isp));
          const next = parseState(res.evaluation, isp);
          const old = statesRef.current[isp.id];
          const changed = old && !old.error && old.fingerprint !== next.fingerprint;
          if (changed) {
            setChanges((cs) => [{ isp: isp.name, at: Date.now(), reason: reasonFor(old, next), from: summarise(old), to: summarise(next) }, ...cs].slice(0, 20));
          }
          setStates((prev) => ({ ...prev, [isp.id]: { ...next, previous: changed ? old : prev[isp.id]?.previous, changedAt: changed ? Date.now() : prev[isp.id]?.changedAt } }));
        } catch (e) {
          setStates((prev) => ({ ...prev, [isp.id]: { ...(prev[isp.id] as SteerState), error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'Evaluation failed.' } }));
        }
      }),
    );
    setLastUpdate(Date.now());
  }, [canEvaluate, selected]);

  // Evaluate on selection change / mount.
  useEffect(() => {
    void evaluateAll();
  }, [evaluateAll]);

  // Repeat on the chosen interval unless paused.
  useEffect(() => {
    if (paused || !canEvaluate) return;
    const t = setInterval(() => void evaluateAll(), intervalSec * 1000);
    return () => clearInterval(t);
  }, [paused, intervalSec, canEvaluate, evaluateAll]);

  // A slow ticker to expire the 10s change highlight and drive the stale indicator.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const staleAfter = intervalSec * 2 * 1000;
  const stale = lastUpdate !== null && now - lastUpdate > staleAfter;

  return (
    <div>
      <div className="page-head">
        <h1>Current Expected DNS Steering</h1>
        <p>
          The delivery platform NS1 is <b>expected</b> to steer each ISP to, evaluated live from the current NS1
          configuration. This is <b>expected steering derived from configuration — not measured traffic.</b>
        </p>
      </div>

      <div className="card">
        <div className="isp-picker">
          {ISPS.map((isp) => {
            const on = selected.includes(isp.id);
            return (
              <label key={isp.id} className={on ? 'on' : ''}>
                <input type="checkbox" checked={on} disabled={!on && selected.length >= MAX_SELECTED} onChange={() => toggle(isp.id)} />
                {isp.name} <span className="mono muted">AS{isp.asn}</span>
              </label>
            );
          })}
        </div>
        <div className="live-controls">
          <button className="ghost" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          <button className="ghost" onClick={() => void evaluateAll()} disabled={!canEvaluate}>Refresh now</button>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.3rem' }}>
            Every
            <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}>
              {INTERVALS.map((s) => (
                <option key={s} value={s}>{s}s</option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {paused && <span className="badge warn">paused</span>}
          {stale && <span className="badge danger">stale</span>}
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {lastUpdate ? `Last update ${new Date(lastUpdate).toLocaleTimeString()}` : 'No update yet'}
          </span>
        </div>
      </div>

      {!canEvaluate && (
        <div className="notice info">
          Live evaluation requires the Viewing Engineer role. NOC users see the steering summary; the full expected-steering
          evaluation (per ISP) needs <code>dns.explain.read</code>.
        </div>
      )}

      {canEvaluate &&
        ISPS.filter((i) => selected.includes(i.id)).map((isp) => {
          const s = states[isp.id];
          const highlighted = s?.changedAt !== undefined && now - s.changedAt < 10000;
          const ispStale = s && now - s.lastUpdated > staleAfter;
          const cls = `isp-card${highlighted ? ' changed' : ''}${s?.error ? ' error' : ispStale ? ' stale' : ''}`;
          return (
            <div key={isp.id} className={cls}>
              <div className="step-head">
                <h3 style={{ margin: 0 }}>
                  {isp.name} <span className="mono muted">AS{isp.asn}</span>
                </h3>
                {highlighted && <span className="badge info">changed</span>}
                {s && !s.error && (s.complete ? <span className="badge ok">complete</span> : <span className="badge warn">partial</span>)}
                {ispStale && !s?.error && <span className="badge warn">stale</span>}
              </div>

              {s?.error ? (
                <div className="notice danger">{s.error}</div>
              ) : !s ? (
                <span className="muted">Evaluating…</span>
              ) : (
                <>
                  <div className="path">
                    <div className="seg"><span className="seg-label">ISP / ASN</span>{isp.name} AS{isp.asn}</div>
                    <div className="seg"><span className="seg-label">Identity source</span>{s.source}</div>
                    <div className="seg"><span className="seg-label">Matched policy</span>{s.chain.join(' → ')}</div>
                    <div className="seg"><span className="seg-label">Eligible platforms</span>{s.eligiblePlatforms.join(', ') || '—'}</div>
                    <div className="seg"><span className="seg-label">Expected DNS distribution</span>{s.complete ? s.distribution.map((d) => `${d.label} ${(d.share * 100).toFixed(0)}%`).join(' · ') || '—' : '— (partial)'}</div>
                    <div className="seg realta"><span className="seg-label">Preferred Réalta path</span>{s.preferredPath} <span className="badge neutral">CONFIGURED</span></div>
                    <div className="seg cloudflare"><span className="seg-label">Downstream</span>Cloudflare Load Balancer</div>
                  </div>
                  <div className="muted" style={{ fontSize: '0.76rem', marginTop: '0.4rem' }}>
                    Measured traffic: <b>Telemetry not connected</b> · updated {new Date(s.lastUpdated).toLocaleTimeString()}
                    {!s.complete && ' · partial evaluation — no definitive platform'}
                  </div>
                  {highlighted && s.previous && (
                    <div className="notice info" style={{ marginTop: '0.4rem' }}>
                      <b>Steering changed.</b> {reasonFor(s.previous, s)}. Previous: {summarise(s.previous)} → now: {summarise(s)}.
                    </div>
                  )}
                  {showDetail && (
                    <details style={{ marginTop: '0.4rem' }}>
                      <summary className="muted">Evaluation trace</summary>
                      <ul className="notes">
                        {s.evaluation.traces.map((t) => (
                          <li key={t.index}>
                            <span className="mono">{t.type}</span> — {t.supported ? t.behaviour : 'unsupported → partial'}: {t.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </div>
          );
        })}

      {canEvaluate && (
        <div className="card">
          <h3>Recent Steering Changes</h3>
          {changes.length === 0 ? (
            <div className="muted">No steering changes observed while this view has been open.</div>
          ) : (
            <div className="matrix-wrap">
              <table className="matrix">
                <thead>
                  <tr><th>Time</th><th>ISP</th><th>Reason</th><th>Previous → Current</th></tr>
                </thead>
                <tbody>
                  {changes.map((c, i) => (
                    <tr key={i}>
                      <td>{new Date(c.at).toLocaleTimeString()}</td>
                      <td>{c.isp}</td>
                      <td>{c.reason}</td>
                      <td className="muted">{c.from} → {c.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

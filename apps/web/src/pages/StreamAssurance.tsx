// Stream Assurance — DASH/HLS/CMAF conformance + cross-CDN consistency. Read-only overview + a
// per-profile CDN comparison and standards findings. A viewing engineer can trigger a diagnostic
// run. Follows the existing RADAR visual language (cards, matrix tables, badges, notices).
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { SaAlert, SaFinding, SaObservation, SaProfileSummary, SaRun } from '../api/types';

const sevBadge = (s: string): string => (s === 'critical' || s === 'error' ? 'danger' : s === 'warning' ? 'warn' : 'neutral');
const stateBadge = (s: string): string => (s === 'active' ? 'danger' : s === 'acknowledged' ? 'neutral' : s === 'resolved' ? 'ok' : 'warn');
const cacheLabel = (t: string): string => (t === 'hit' ? 'HIT' : t === 'miss' ? 'MISS' : '—');

function ComparisonTable({ run }: { run: SaRun }) {
  const ref = run.observations.find((o) => o.role === 'reference');
  const refKid = ref?.kid ?? null;
  const kidDiffers = (o: SaObservation) => o.role !== 'reference' && o.kid != null && refKid != null && o.kid !== refKid;
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead><tr><th>Endpoint</th><th>Provider</th><th>KID</th><th>Cache (edge / parent)</th><th>Origin</th><th>Last-Modified</th><th>Status</th></tr></thead>
        <tbody>
          {run.observations.map((o) => (
            <tr key={o.endpointId}>
              <td>{o.endpointId}{o.role === 'reference' && <span className="badge neutral badge-sm" style={{ marginLeft: '0.3rem' }}>reference</span>}</td>
              <td className="muted">{o.provider}</td>
              <td className={kidDiffers(o) ? 'danger mono' : 'mono'} title={o.kid ?? ''}>{o.kid ? `${o.kid.slice(0, 8)}…` : '—'}</td>
              <td className="mono">{cacheLabel(o.cdn.edge)} / {cacheLabel(o.cdn.parent)}{o.cdn.fetchedFromOrigin && <span className="muted"> · from origin</span>}</td>
              <td className="muted">{o.cdn.originIdentity ?? '—'}</td>
              <td className="muted">{o.lastModified ?? '—'}</td>
              <td>{o.error ? <span className="badge danger badge-sm">error</span> : o.reachable ? <span className="badge ok badge-sm">{o.httpStatus}</span> : <span className="badge danger badge-sm">unreachable</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Findings({ findings }: { findings: SaFinding[] }) {
  if (findings.length === 0) return <div className="notice ok"><span className="live-dot" /> No findings — endpoints are consistent.</div>;
  return (
    <div className="sa-findings">
      {findings.map((f, i) => (
        <div key={i} className={`sa-finding sa-sev-${f.severity}`}>
          <div className="sa-finding-head">
            <span className={`badge ${sevBadge(f.severity)}`}>{f.severity}</span>
            <strong>{f.classification}</strong>
            <span className="muted mono">{f.ruleId}</span>
            <span className="muted">· {f.provider} · likely {f.likelyLayer}</span>
          </div>
          <p className="sa-finding-explain">{f.explanation}</p>
          <p className="muted sa-finding-fix"><strong>Fix:</strong> {f.remediation}</p>
        </div>
      ))}
    </div>
  );
}

export function StreamAssurance() {
  const { hasPermission } = useAuth();
  const canRun = hasPermission('dns.explain.read');
  const [profiles, setProfiles] = useState<SaProfileSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<SaRun | null>(null);
  const [alerts, setAlerts] = useState<SaAlert[]>([]);
  const [eventOn, setEventOn] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAlerts = (id: string) => api.saAlerts(id)
    .then((r) => { setAlerts(r.alerts); setEventOn(r.eventModeProfiles.includes(id)); })
    .catch(() => { setAlerts([]); setEventOn(false); });

  useEffect(() => {
    api.saProfiles()
      .then((r) => { setProfiles(r.profiles); if (r.profiles[0] && !selected) setSelected(r.profiles[0].id); })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load stream profiles.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) { setRun(null); setAlerts([]); return; }
    let active = true;
    api.saLatest(selected).then((r) => { if (active) setRun(r.run); }).catch(() => { if (active) setRun(null); });
    void loadAlerts(selected);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const runNow = async () => {
    if (!selected) return;
    setRunning(true); setError(null);
    try { const r = await api.saRun(selected); setRun(r.run); await loadAlerts(selected); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Run failed.'); }
    finally { setRunning(false); }
  };

  const act = async (fn: () => Promise<unknown>, key: string) => {
    if (!selected) return;
    setBusy(key); setError(null);
    try { await fn(); await loadAlerts(selected); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Action failed.'); }
    finally { setBusy(null); }
  };
  const toggleEventMode = () => act(() => api.saEventMode(selected!, !eventOn, 30), 'event');

  const current = profiles?.find((p) => p.id === selected) ?? null;

  return (
    <section className="page">
      <header className="page-head">
        <h1>Stream Assurance</h1>
        <div className="head-meta"><span className="muted">DASH / HLS / CMAF conformance · cross-CDN consistency</span></div>
      </header>

      {error && <div className="notice danger">{error}</div>}
      {profiles && profiles.length === 0 && <div className="notice info">No stream profiles configured yet. An Engineer can add one (channel + CDN endpoints) via the API.</div>}

      {profiles && profiles.length > 0 && (
        <div className="sa-layout">
          <nav className="sa-profiles">
            {profiles.map((p) => (
              <button key={p.id} className={`sa-profile${selected === p.id ? ' active' : ''}`} onClick={() => setSelected(p.id)}>
                <span className="sa-profile-name">{p.name}</span>
                <span className="muted">{p.endpointCount} endpoints{p.tags.length ? ` · ${p.tags.join(', ')}` : ''}</span>
              </button>
            ))}
          </nav>

          <div className="sa-detail">
            {current && (
              <div className="sa-detail-head">
                <h2 style={{ margin: 0 }}>{current.name}</h2>
                <div className="sa-detail-actions">
                  {run && <span className="muted">last run {new Date(run.startedAt).toLocaleTimeString()} · {run.findingCount} finding{run.findingCount === 1 ? '' : 's'}</span>}
                  {eventOn && <span className="badge warn badge-sm">event mode</span>}
                  {canRun && <button className={`btn${eventOn ? ' active' : ''}`} onClick={toggleEventMode} disabled={busy === 'event'}>{eventOn ? 'Stop event mode' : 'Event mode'}</button>}
                  {canRun && <button className="btn" onClick={runNow} disabled={running}>{running ? 'Running…' : 'Run now'}</button>}
                </div>
              </div>
            )}

            {alerts.length > 0 && (
              <div className="sa-alerts">
                <h3 style={{ margin: '0 0 0.5rem' }}>Active alerts <span className="muted">· {alerts.length}</span></h3>
                {alerts.map((al) => (
                  <div key={al.id} className={`sa-finding sa-sev-${al.severity}`}>
                    <div className="sa-finding-head">
                      <span className={`badge ${stateBadge(al.state)}`}>{al.state}</span>
                      <strong>{al.classification}</strong>
                      <span className="muted mono">{al.ruleId} · {al.endpointId}</span>
                      <span className="muted">· seen ×{al.occurrences}</span>
                      {canRun && al.state !== 'acknowledged' && <button className="linklike" onClick={() => act(() => api.saAckAlert(al.id), al.id)} disabled={busy === al.id}>acknowledge</button>}
                      {canRun && <button className="linklike" onClick={() => act(() => api.saResolveAlert(al.id), al.id)} disabled={busy === al.id}>resolve</button>}
                    </div>
                    {al.explanation && <p className="sa-finding-explain">{al.explanation}</p>}
                  </div>
                ))}
              </div>
            )}

            {run ? (
              <>
                <ComparisonTable run={run} />
                <h3 style={{ marginTop: '1.25rem' }}>Findings</h3>
                <Findings findings={run.findings} />
              </>
            ) : (
              <div className="notice info">No run yet for this profile.{canRun ? ' Use “Run now” to check the endpoints.' : ''}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

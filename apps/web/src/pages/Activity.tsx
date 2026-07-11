// Activity — two clearly separated read-only views:
//   RADAR Activity — RADAR's own audit trail (GET /api/v1/audit), e.g. snapshot captures.
//   NS1 Activity   — the NS1 account activity log (GET /api/v1/ns1/activity), mock-labelled.
// Both require audit.read (the API enforces it; the UI fails closed for a NOC viewer).
// Nothing here is a write path; details panels are safe (credential-like fields stripped
// server-side).
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ProvenanceLine } from '../components/Provenance';
import type { ActivityResponse, AuditListResponse } from '../api/types';

const contains = (hay: string | undefined, needle: string) => !needle || (hay ?? '').toLowerCase().includes(needle.toLowerCase());

function RadarAudit() {
  const [data, setData] = useState<AuditListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');
  const [outcome, setOutcome] = useState('');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');

  useEffect(() => {
    let active = true;
    api
      .audit(200)
      .then((r) => active && setData(r))
      .catch((e: unknown) => active && setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load the RADAR audit history.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(
    () =>
      (data?.items ?? []).filter(
        (i) =>
          contains(i.actorSubject, actor) &&
          contains(i.action, action) &&
          contains(`${i.resourceType ?? ''} ${i.resourceKey ?? ''}`, resource) &&
          contains(i.outcome, outcome) &&
          (!after || new Date(i.occurredAt) >= new Date(after)) &&
          (!before || new Date(i.occurredAt) <= new Date(`${before}T23:59:59`)),
      ),
    [data, actor, action, resource, outcome, after, before],
  );

  return (
    <div>
      <div className="filters">
        <label className="field">Actor<input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="subject" /></label>
        <label className="field">Action<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="snapshot.create" /></label>
        <label className="field">Resource<input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="rte.ie" /></label>
        <label className="field">Outcome<input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="success" /></label>
        <label className="field">After<input type="date" value={after} onChange={(e) => setAfter(e.target.value)} /></label>
        <label className="field">Before<input type="date" value={before} onChange={(e) => setBefore(e.target.value)} /></label>
      </div>
      <div className="muted" style={{ fontSize: '0.78rem' }}>RADAR audit trail (this platform's own actions) · read-only.</div>

      {loading ? (
        <div className="center-note">Loading audit history…</div>
      ) : error ? (
        <div className="notice danger">{error}</div>
      ) : rows.length === 0 ? (
        <div className="notice info">{(data?.items.length ?? 0) === 0 ? 'No RADAR audit events recorded.' : 'No events match the current filters.'}</div>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Auth</th><th>Correlation</th><th>Details</th></tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>{new Date(i.occurredAt).toLocaleString()}</td>
                  <td>{i.actorSubject ?? '—'}</td>
                  <td>{i.action}</td>
                  <td>{i.resourceType ? `${i.resourceType} ` : ''}<span className="mono">{i.resourceKey ?? '—'}</span></td>
                  <td><span className={`badge ${i.outcome === 'success' ? 'ok' : i.outcome === 'failure' ? 'danger' : 'neutral'}`}>{i.outcome}</span></td>
                  <td>{i.authenticationMethod ?? '—'}</td>
                  <td className="mono">{i.correlationId ?? '—'}</td>
                  <td>
                    <details><summary className="muted">details</summary><pre className="raw-json" style={{ maxWidth: 420 }}>{JSON.stringify(i.details, null, 2)}</pre></details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Ns1Activity() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');

  useEffect(() => {
    let active = true;
    api
      .activity(200)
      .then((r) => active && setData(r))
      .catch((e: unknown) => active && setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load NS1 activity.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(
    () => (data?.items ?? []).filter((i) => contains(i.actor, actor) && contains(i.action, action) && contains(`${i.resourceType ?? ''} ${i.resourceKey ?? ''}`, resource)),
    [data, actor, action, resource],
  );

  return (
    <div>
      <div className="filters">
        <label className="field">Actor<input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="user or key" /></label>
        <label className="field">Action<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="update / view" /></label>
        <label className="field">Resource<input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="rte.ie" /></label>
      </div>
      {data && <ProvenanceLine p={data.provenance} />}
      {data && <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>{data.mappingNote}</div>}

      {loading ? (
        <div className="center-note">Loading NS1 activity…</div>
      ) : error ? (
        <div className="notice danger">{error}</div>
      ) : rows.length === 0 ? (
        <div className="notice info">{(data?.items.length ?? 0) === 0 ? 'No NS1 activity recorded.' : 'No NS1 activity matches the current filters.'}</div>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Detail</th><th>Raw</th></tr>
            </thead>
            <tbody>
              {rows.map((i, idx) => (
                <tr key={i.id ?? idx}>
                  <td>{i.occurredAt ? new Date(i.occurredAt).toLocaleString() : '—'}</td>
                  <td>{i.actor ?? '—'}</td>
                  <td>{i.action ?? '—'}</td>
                  <td>{i.resourceType ? `${i.resourceType} ` : ''}<span className="mono">{i.resourceKey ?? '—'}</span></td>
                  <td>{i.outcome ?? '—'}</td>
                  <td>{i.detail ?? '—'}</td>
                  <td>
                    <details><summary className="muted">raw</summary><pre className="raw-json" style={{ maxWidth: 420 }}>{JSON.stringify(i.raw, null, 2)}</pre></details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Activity() {
  const { hasPermission } = useAuth();
  const canView = hasPermission('audit.read');
  const [tab, setTab] = useState<'radar' | 'ns1'>('radar');

  if (!canView) {
    return (
      <div>
        <div className="page-head"><h1>Activity</h1></div>
        <div className="notice info">You do not have permission to view activity (requires the Viewing Engineer role).</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1>Activity</h1>
        <p>RADAR's own audit trail and the NS1 account activity log — read-only.</p>
      </div>
      <div className="card">
        <div className="topo-toolbar">
          <button className={`ghost ${tab === 'radar' ? 'active' : ''}`} onClick={() => setTab('radar')}>RADAR Activity</button>
          <button className={`ghost ${tab === 'ns1' ? 'active' : ''}`} onClick={() => setTab('ns1')}>NS1 Activity</button>
        </div>
        {tab === 'radar' ? <RadarAudit /> : <Ns1Activity />}
      </div>
    </div>
  );
}

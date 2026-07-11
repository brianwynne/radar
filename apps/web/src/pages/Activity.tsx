// Activity — read-only NS1 account activity log (GET /api/v1/ns1/activity). Requires
// audit.read (the API enforces it; the UI also fails closed for a NOC viewer). Filters
// operate on the API-provided data; the raw/details view is safe (credential-like fields
// are stripped server-side) and shown per row.
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ProvenanceLine } from '../components/Provenance';
import type { ActivityResponse } from '../api/types';

export function Activity() {
  const { hasPermission } = useAuth();
  const canView = hasPermission('audit.read');

  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    let active = true;
    api
      .activity(200)
      .then((r) => active && setData(r))
      .catch((e: unknown) => active && setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load activity.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [canView]);

  const rows = useMemo(() => {
    const has = (hay: string | undefined, needle: string) => !needle || (hay ?? '').toLowerCase().includes(needle.toLowerCase());
    return (data?.items ?? []).filter(
      (i) => has(i.actor, actor) && has(i.action, action) && has(`${i.resourceType ?? ''} ${i.resourceKey ?? ''}`, resource),
    );
  }, [data, actor, action, resource]);

  if (!canView) {
    return (
      <div>
        <div className="page-head">
          <h1>Activity</h1>
        </div>
        <div className="notice info">You do not have permission to view the activity log (requires the Viewing Engineer role).</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1>Activity</h1>
        <p>Read-only NS1 account activity log. RADAR never writes to NS1.</p>
      </div>

      <div className="card">
        <div className="filters">
          <label className="field">
            Actor
            <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="user or key" />
          </label>
          <label className="field">
            Action
            <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="update / view" />
          </label>
          <label className="field">
            Resource
            <input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="rte.ie" />
          </label>
        </div>

        {data && <ProvenanceLine p={data.provenance} />}
        {data && <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>{data.mappingNote}</div>}

        {loading ? (
          <div className="center-note">Loading activity…</div>
        ) : error ? (
          <div className="notice danger">{error}</div>
        ) : rows.length === 0 ? (
          <div className="notice info">{(data?.items.length ?? 0) === 0 ? 'No activity recorded.' : 'No activity matches the current filters.'}</div>
        ) : (
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                  <th>Raw</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i, idx) => (
                  <tr key={i.id ?? idx}>
                    <td>{i.occurredAt ? new Date(i.occurredAt).toLocaleString() : '—'}</td>
                    <td>{i.actor ?? '—'}</td>
                    <td>{i.action ?? '—'}</td>
                    <td>
                      {i.resourceType ? `${i.resourceType} ` : ''}
                      <span className="mono">{i.resourceKey ?? '—'}</span>
                    </td>
                    <td>{i.outcome ?? '—'}</td>
                    <td>{i.detail ?? '—'}</td>
                    <td>
                      <details>
                        <summary className="muted">raw</summary>
                        <pre className="raw-json" style={{ maxWidth: 420 }}>{JSON.stringify(i.raw, null, 2)}</pre>
                      </details>
                    </td>
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

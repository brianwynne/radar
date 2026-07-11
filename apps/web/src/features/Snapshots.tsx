// Snapshot history and comparison for a record, shown inside the NS1 Explorer. Requires
// snapshot.read to view; snapshot.create to capture. Capture stores the record via the
// backend (raw + canonical + checksums, atomic audit); RADAR never writes to NS1.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { SyntheticTag } from '../components/Provenance';
import type { CompareResponse, SnapshotSummary } from '../api/types';

const short = (c?: string) => (c ? c.replace(/^sha256:/, '').slice(0, 10) : '—');

function DiffView({ cmp }: { cmp: CompareResponse }) {
  if (cmp.identical) {
    return <div className="notice ok">Snapshots are identical (same structural checksum).</div>;
  }
  return (
    <div>
      <div className="muted" style={{ marginBottom: '0.4rem' }}>
        {cmp.diffCount} change{cmp.diffCount === 1 ? '' : 's'}
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Path</th>
              <th>Change</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {cmp.diff.map((d, i) => (
              <tr key={i}>
                <td className="mono">{d.path}</td>
                <td>
                  <span className={`badge ${d.kind === 'added' ? 'ok' : d.kind === 'removed' ? 'danger' : 'info'}`}>{d.kind}</span>
                </td>
                <td className="mono">{d.before === undefined ? '—' : JSON.stringify(d.before)}</td>
                <td className="mono">{d.after === undefined ? '—' : JSON.stringify(d.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SnapshotsPanel({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('snapshot.create');

  const [history, setHistory] = useState<SnapshotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [cmp, setCmp] = useState<CompareResponse | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .snapshots(zone, domain, type)
      .then((r) => setHistory(r.snapshots ?? []))
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load snapshots.'));
  }, [zone, domain, type]);

  useEffect(() => {
    setHistory(null);
    setSelected([]);
    setCmp(null);
    load();
  }, [load]);

  const capture = async () => {
    setCapturing(true);
    setError(null);
    try {
      await api.captureSnapshot(zone, domain, type);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Capture failed.');
    } finally {
      setCapturing(false);
    }
  };

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));

  const runCompare = async () => {
    if (selected.length !== 2) return;
    setCmpError(null);
    setCmp(null);
    try {
      setCmp(await api.compareSnapshots(selected[0], selected[1]));
    } catch (e) {
      setCmpError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Compare failed.');
    }
  };

  return (
    <div className="card">
      <div className="step-head">
        <h3 style={{ margin: 0 }}>Snapshots</h3>
        {canCreate && (
          <button className="primary" onClick={capture} disabled={capturing}>
            {capturing ? 'Capturing…' : 'Capture snapshot'}
          </button>
        )}
        {selected.length === 2 && (
          <button className="ghost" onClick={runCompare}>
            Compare selected
          </button>
        )}
      </div>

      {error && <div className="notice danger">{error}</div>}

      {history === null ? (
        <span className="muted">Loading snapshots…</span>
      ) : history.length === 0 ? (
        <div className="notice info">No snapshots captured for this record yet.</div>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>Compare</th>
                <th>Captured</th>
                <th>By</th>
                <th>Label</th>
                <th>Checksum</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input type="checkbox" aria-label={`select ${s.id}`} checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                  </td>
                  <td>{new Date(s.retrievedAt).toLocaleString()}</td>
                  <td>{s.createdBySubject ?? '—'}</td>
                  <td>{s.label ?? '—'}</td>
                  <td className="mono" title={s.rawChecksum}>
                    {short(s.rawChecksum)}
                  </td>
                  <td>
                    <SyntheticTag synthetic={Boolean(s.metadata?.synthetic)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cmpError && <div className="notice danger">{cmpError}</div>}
      {cmp && (
        <div style={{ marginTop: '0.75rem' }}>
          <h3>Comparison</h3>
          <DiffView cmp={cmp} />
        </div>
      )}
    </div>
  );
}

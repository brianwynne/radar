// Snapshot history and comparison for a record, shown inside the NS1 Explorer. Requires
// snapshot.read to view; snapshot.create to capture/rename. Capture stores the record via the
// backend (raw + canonical + checksums, atomic audit); RADAR never writes to NS1.
//
// A captured snapshot can be compared two ways: against ANOTHER snapshot, or against the CURRENT
// version of any NS1 record in the zone (fetched live) — e.g. a captured `live` config vs the
// current `livebase`. Both diffs are field-level JsonDiffEntry lists, rendered the same way.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { SyntheticTag } from '../components/Provenance';
import type { JsonDiffEntry, SnapshotSummary } from '../api/types';

const short = (c?: string) => (c ? c.replace(/^sha256:/, '').slice(0, 10) : '—');

type CompareMode = 'snapshot' | 'record';
type ZoneRecord = { domain: string; type: string };
type CompareView = { identical: boolean; entries: JsonDiffEntry[]; heading: string; warnings: string[] };

function DiffView({ view }: { view: CompareView }) {
  return (
    <div>
      <div className="muted" style={{ marginBottom: '0.4rem' }}>{view.heading}</div>
      {view.warnings.map((w, i) => (
        <div key={i} className="notice warn">{w}</div>
      ))}
      {view.identical ? (
        <div className="notice ok">Identical (same structural checksum).</div>
      ) : (
        <>
          <div className="muted" style={{ marginBottom: '0.4rem' }}>
            {view.entries.length} change{view.entries.length === 1 ? '' : 's'}
          </div>
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr>
              </thead>
              <tbody>
                {view.entries.map((d, i) => (
                  <tr key={i}>
                    <td className="mono">{d.path}</td>
                    <td><span className={`badge ${d.kind === 'added' ? 'ok' : d.kind === 'removed' ? 'danger' : 'info'}`}>{d.kind}</span></td>
                    <td className="mono">{d.before === undefined ? '—' : JSON.stringify(d.before)}</td>
                    <td className="mono">{d.after === undefined ? '—' : JSON.stringify(d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
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
  const [cmp, setCmp] = useState<CompareView | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null); // snapshot currently being renamed
  const [draftLabel, setDraftLabel] = useState('');
  const [savingLabel, setSavingLabel] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Compare-with mode + the NS1 record chosen for record-mode ("domain|type").
  const [mode, setMode] = useState<CompareMode>('snapshot');
  const [recordChoice, setRecordChoice] = useState('');
  const [zoneRecords, setZoneRecords] = useState<ZoneRecord[] | null>(null);

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
    setMode('snapshot');
    setRecordChoice('');
    setZoneRecords(null); // records belong to the zone; refetch when the record (hence zone) changes
    load();
  }, [load]);

  // The zone's records, fetched lazily the first time record-compare mode is used.
  const loadZoneRecords = useCallback(() => {
    api
      .zone(zone)
      .then((r) => {
        const raw = Array.isArray((r.zone as { records?: unknown }).records) ? ((r.zone as { records: unknown[] }).records) : [];
        setZoneRecords(
          raw
            .map((x) => x as { domain?: string; type?: string })
            .filter((x): x is ZoneRecord => Boolean(x.domain && x.type))
            .map((x) => ({ domain: x.domain, type: x.type })),
        );
      })
      .catch((e: unknown) => setCmpError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load the zone records.'));
  }, [zone]);

  const chooseMode = (next: CompareMode) => {
    setMode(next);
    setCmp(null);
    setCmpError(null);
    if (next === 'record') {
      setSelected((s) => s.slice(-1)); // record-compare needs exactly one snapshot
      if (zoneRecords === null) loadZoneRecords();
    }
  };

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

  const toggle = (id: string) => {
    const max = mode === 'record' ? 1 : 2;
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-max)));
  };

  const startRename = (s: SnapshotSummary) => {
    setRenameId(s.id);
    setDraftLabel(s.label ?? '');
    setError(null);
  };
  const cancelRename = () => {
    setRenameId(null);
    setDraftLabel('');
  };
  const saveRename = async (id: string) => {
    setSavingLabel(true);
    setError(null);
    try {
      const trimmed = draftLabel.trim();
      await api.renameSnapshot(id, trimmed ? trimmed : null);
      cancelRename();
      load();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Rename failed.');
    } finally {
      setSavingLabel(false);
    }
  };

  const removeSnapshot = async (s: SnapshotSummary) => {
    const name = s.label ? `"${s.label}"` : new Date(s.retrievedAt).toLocaleString();
    if (!window.confirm(`Delete snapshot ${name}? This cannot be undone.`)) return;
    setDeletingId(s.id);
    setError(null);
    try {
      await api.deleteSnapshot(s.id);
      setSelected((sel) => sel.filter((x) => x !== s.id));
      if (cmp) setCmp(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Delete failed.');
    } finally {
      setDeletingId(null);
    }
  };

  const canCompare = mode === 'snapshot' ? selected.length === 2 : selected.length === 1 && recordChoice !== '';
  const runCompare = async () => {
    if (!canCompare) return;
    setComparing(true);
    setCmpError(null);
    setCmp(null);
    try {
      if (mode === 'snapshot') {
        const r = await api.compareSnapshots(selected[0], selected[1]);
        setCmp({ identical: r.identical, entries: r.diff, heading: 'Snapshot ↔ snapshot', warnings: [] });
      } else {
        const [rDomain, rType] = recordChoice.split('|');
        const r = await api.compareCurrent(selected[0], { zone, domain: rDomain, type: rType });
        setCmp({ identical: r.identical, entries: r.changes, heading: `Snapshot ↔ current ${rDomain} (${rType})`, warnings: r.warnings ?? [] });
      }
    } catch (e) {
      setCmpError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Compare failed.');
    } finally {
      setComparing(false);
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
      </div>

      {error && <div className="notice danger">{error}</div>}

      {history === null ? (
        <span className="muted">Loading snapshots…</span>
      ) : history.length === 0 ? (
        <div className="notice info">No snapshots captured for this record yet.</div>
      ) : (
        <>
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
                  {canCreate && <th></th>}
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input type="checkbox" aria-label={`select ${s.id}`} checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                    </td>
                    <td>
                      <Link to={`/snapshots/${s.id}`}>{new Date(s.retrievedAt).toLocaleString()}</Link>
                    </td>
                    <td>{s.createdBySubject ?? '—'}</td>
                    <td>
                      {renameId === s.id ? (
                        <span className="rename-inline">
                          <input
                            autoFocus
                            aria-label={`rename ${s.id}`}
                            value={draftLabel}
                            maxLength={200}
                            placeholder="Snapshot label"
                            onChange={(e) => setDraftLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveRename(s.id);
                              if (e.key === 'Escape') cancelRename();
                            }}
                          />
                          <button className="linklike" disabled={savingLabel} onClick={() => void saveRename(s.id)}>Save</button>
                          <button className="linklike muted" disabled={savingLabel} onClick={cancelRename}>Cancel</button>
                        </span>
                      ) : (
                        <span className="rename-inline">
                          <span>{s.label ?? '—'}</span>
                          {canCreate && (
                            <button className="linklike" aria-label={`rename snapshot ${s.id}`} title="Rename this snapshot" onClick={() => startRename(s)}>
                              {s.label ? 'Rename' : 'Add label'}
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="mono" title={s.rawChecksum}>
                      {short(s.rawChecksum)}
                    </td>
                    <td>
                      <SyntheticTag synthetic={Boolean(s.metadata?.synthetic)} />
                    </td>
                    {canCreate && (
                      <td>
                        <button className="linklike danger" aria-label={`delete snapshot ${s.id}`} title="Delete this snapshot" disabled={deletingId === s.id} onClick={() => void removeSnapshot(s)}>
                          {deletingId === s.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Compare controls: pick a snapshot, then choose what to compare it with. */}
          <fieldset className="compare-controls">
            <legend>Compare with</legend>
            <label className="radio">
              <input type="radio" name="compare-mode" checked={mode === 'snapshot'} onChange={() => chooseMode('snapshot')} />
              Another snapshot <span className="muted">(select two rows)</span>
            </label>
            <label className="radio">
              <input type="radio" name="compare-mode" checked={mode === 'record'} onChange={() => chooseMode('record')} />
              A current NS1 record <span className="muted">(select one row, then pick a record)</span>
            </label>
            {mode === 'record' && (
              <label className="field">
                <span>Record</span>
                <select aria-label="NS1 record to compare against" value={recordChoice} onChange={(e) => setRecordChoice(e.target.value)} disabled={zoneRecords === null}>
                  <option value="">{zoneRecords === null ? 'Loading records…' : 'Select a record…'}</option>
                  {(zoneRecords ?? []).map((r) => (
                    <option key={`${r.domain}|${r.type}`} value={`${r.domain}|${r.type}`}>
                      {r.domain} ({r.type})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="ghost" onClick={runCompare} disabled={!canCompare || comparing}>
              {comparing ? 'Comparing…' : 'Compare'}
            </button>
          </fieldset>
        </>
      )}

      {cmpError && <div className="notice danger">{cmpError}</div>}
      {cmp && (
        <div style={{ marginTop: '0.75rem' }}>
          <h3>Comparison</h3>
          <DiffView view={cmp} />
        </div>
      )}
    </div>
  );
}

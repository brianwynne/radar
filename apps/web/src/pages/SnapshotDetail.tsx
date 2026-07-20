// Snapshot detail — inspect a stored snapshot in full and compare it with the CURRENT NS1
// record. This is a READ-ONLY comparison: there is no Restore/Apply control and no NS1
// write path. Raw payload requires ns1.raw.read; everything else requires snapshot.read.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { SyntheticTag } from '../components/Provenance';
import { RecordEditor } from '../components/RecordEditor';
import type { CompareCurrentResponse, JsonDiffEntry, SnapshotDetail as Detail } from '../api/types';

type Tab = 'summary' | 'canonical' | 'raw';

function SummaryCards({ cmp }: { cmp: CompareCurrentResponse }) {
  const s = cmp.summary;
  const cell = (label: string, value: string, cls = 'neutral') => (
    <div className="card" style={{ margin: 0 }}>
      <div className="muted">{label}</div>
      <div>
        <span className={`badge ${cls}`}>{value}</span>
      </div>
    </div>
  );
  return (
    <div className="grid cols-3">
      {cell('TTL', s.ttlChanged ? 'changed' : 'unchanged', s.ttlChanged ? 'warn' : 'neutral')}
      {cell('ECS setting', s.ecsChanged ? 'changed' : 'unchanged', s.ecsChanged ? 'warn' : 'neutral')}
      {cell('Answers', `+${s.answersAdded} / −${s.answersRemoved} / ~${s.answersChanged}`, s.answersAdded + s.answersRemoved + s.answersChanged ? 'info' : 'neutral')}
      {cell('Filters', `+${s.filtersAdded} / −${s.filtersRemoved} / ~${s.filtersChanged}`, s.filtersAdded + s.filtersRemoved + s.filtersChanged ? 'info' : 'neutral')}
      {cell('Filter order', s.filtersReordered ? 'reordered' : 'unchanged', s.filtersReordered ? 'warn' : 'neutral')}
      {cell('Other structural', String(s.otherChanges), s.otherChanges ? 'info' : 'neutral')}
    </div>
  );
}

function ChangeTable({ changes }: { changes: JsonDiffEntry[] }) {
  if (changes.length === 0) return <div className="notice ok">No field-level differences.</div>;
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th>Path</th>
            <th>Change</th>
            <th>Stored</th>
            <th>Current</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((d, i) => (
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
  );
}

export function SnapshotDetail() {
  const { snapshotId } = useParams<{ snapshotId: string }>();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('snapshot.read');
  const canRaw = hasPermission('ns1.raw.read');

  const [snap, setSnap] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('summary');
  const [cmp, setCmp] = useState<CompareCurrentResponse | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [editingRaw, setEditingRaw] = useState(false); // raw-tab record editor (edit + Copy for NS1)
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    if (!canRead || !snapshotId) {
      setLoading(false);
      return;
    }
    let active = true;
    api
      .snapshot(snapshotId)
      .then((r) => active && setSnap(r.snapshot))
      .catch((e: unknown) => active && setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load the snapshot.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [snapshotId, canRead]);

  const compare = async () => {
    if (!snapshotId) return;
    setComparing(true);
    setCmpError(null);
    try {
      setCmp(await api.compareCurrent(snapshotId));
    } catch (e) {
      setCmpError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Comparison failed.');
    } finally {
      setComparing(false);
    }
  };

  if (!canRead) {
    return (
      <div>
        <div className="page-head">
          <h1>Snapshot</h1>
        </div>
        <div className="notice info">You do not have permission to view snapshots (requires the Viewing Engineer role).</div>
      </div>
    );
  }
  if (loading) return <div className="center-note">Loading snapshot…</div>;
  if (error) return <div className="notice danger">{error}</div>;
  if (!snap) return null;

  const parts = snap.resourceKey.split('/');
  const recordLink = parts.length === 3 ? `/explorer/${parts[0]}/${parts[1]}/${parts[2]}` : undefined;

  return (
    <div>
      <div className="page-head">
        <h1>Snapshot {snap.label ? `— ${snap.label}` : ''}</h1>
        <p>
          Stored snapshot of <span className="mono">{snap.resourceKey}</span>.{' '}
          {recordLink && <Link to={recordLink}>View current record →</Link>}
        </p>
      </div>

      <div className="card">
        <h3>Metadata &amp; provenance</h3>
        <div className="kv"><span>Resource</span><span className="mono">{snap.resourceKey}</span></div>
        <div className="kv"><span>Captured by</span><span>{snap.createdBySubject ?? '—'}</span></div>
        <div className="kv"><span>Captured at</span><span>{new Date(snap.createdAt).toLocaleString()}</span></div>
        <div className="kv"><span>Record retrieved at</span><span>{new Date(snap.retrievedAt).toLocaleString()}</span></div>
        <div className="kv"><span>Source mode</span><span>{snap.metadata?.mode ?? '—'} <SyntheticTag synthetic={Boolean(snap.metadata?.synthetic)} /></span></div>
        <div className="kv"><span>Raw checksum</span><span className="mono">{snap.rawChecksum}</span></div>
        <div className="kv"><span>Structural checksum</span><span className="mono">{snap.structuralChecksum ?? '—'}</span></div>
        {Array.isArray(snap.metadata?.warnings) && snap.metadata.warnings.length > 0 && (
          <div className="notice warn" style={{ marginTop: '0.5rem' }}>{snap.metadata.warnings.join(' ')}</div>
        )}
      </div>

      <div className="card">
        <div className="topo-toolbar">
          <button className={`ghost ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>Summary</button>
          <button className={`ghost ${tab === 'canonical' ? 'active' : ''}`} onClick={() => setTab('canonical')}>Canonical payload</button>
          <button className={`ghost ${tab === 'raw' ? 'active' : ''}`} onClick={() => setTab('raw')} disabled={!canRaw} title={canRaw ? 'Raw NS1 payload' : 'Requires the ns1.raw.read permission'}>
            Raw payload
          </button>
        </div>

        {tab === 'canonical' && <pre className="raw-json">{JSON.stringify(snap.canonicalPayload, null, 2)}</pre>}
        {tab === 'raw' &&
          (canRaw ? (
            <>
              <div className="step-head">
                <button className={`ghost ${editingRaw ? 'active' : ''}`} onClick={() => setEditingRaw((v) => !v)} title="Edit this snapshot's JSON and copy an NS1-ready payload">
                  {editingRaw ? 'Done editing' : 'Edit / Copy for NS1'}
                </button>
              </div>
              {editingRaw ? (
                <RecordEditor initial={snap.rawPayload} onClose={() => setEditingRaw(false)} />
              ) : (
                <pre className="raw-json">{JSON.stringify(snap.rawPayload, null, 2)}</pre>
              )}
            </>
          ) : (
            <div className="notice info">The raw payload requires the <code>ns1.raw.read</code> permission.</div>
          ))}

        {tab === 'summary' && (
          <div>
            <div className="step-head">
              <button className="primary" onClick={compare} disabled={comparing}>
                {comparing ? 'Comparing…' : 'Compare with current'}
              </button>
            </div>
            <div className="notice info" style={{ marginTop: '0.6rem' }}>
              <b>Comparison only — no NS1 change has been made.</b> RADAR is read-only to NS1; this compares the stored
              snapshot with the current record and never restores or applies anything.
            </div>
            {cmpError && <div className="notice danger">{cmpError}</div>}
            {cmp && (
              <div style={{ marginTop: '0.5rem' }}>
                <div className="step-head">
                  <h3 style={{ margin: 0 }}>Snapshot vs current record</h3>
                  {cmp.identical ? <span className="badge ok">identical</span> : <span className="badge warn">changed</span>}
                </div>
                {cmp.warnings.map((w, i) => (
                  <div key={i} className="notice warn">{w}</div>
                ))}
                <div className="grid cols-2">
                  <div className="card" style={{ margin: 0 }}>
                    <h3>Stored snapshot</h3>
                    <div className="kv"><span>Captured</span><span>{new Date(cmp.snapshot.capturedAt).toLocaleString()}</span></div>
                    <div className="kv"><span>Source</span><span>{cmp.snapshot.sourceMode ?? '—'} <SyntheticTag synthetic={cmp.snapshot.synthetic} /></span></div>
                    <div className="kv"><span>Structural checksum</span><span className="mono">{cmp.snapshot.structuralChecksum ?? '—'}</span></div>
                  </div>
                  <div className="card" style={{ margin: 0 }}>
                    <h3>Current record</h3>
                    <div className="kv"><span>Retrieved</span><span>{new Date(cmp.current.retrievedAt).toLocaleString()}</span></div>
                    <div className="kv"><span>Source</span><span>{cmp.current.sourceMode} <SyntheticTag synthetic={cmp.current.synthetic} /></span></div>
                    <div className="kv"><span>Structural checksum</span><span className="mono">{cmp.current.structuralChecksum}</span></div>
                  </div>
                </div>
                <h3 style={{ marginTop: '0.75rem' }}>Change summary</h3>
                <SummaryCards cmp={cmp} />
                <h3 style={{ marginTop: '0.75rem' }}>Field changes</h3>
                <ChangeTable changes={cmp.changes} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// NS1 live-validation screen. Read-only: validates live/mock NS1 data against RADAR's
// runtime schemas, adapter and synthetic fixtures, and reports compatibility. RADAR never
// writes to NS1. The sanitised fixture candidate is a downloadable draft only — it is never
// committed automatically and always requires operator review.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { ValidationOverallStatus, ValidationResultItem } from '../api/types';

const STATUS_BADGE: Record<ValidationOverallStatus, string> = {
  compatible: 'ok',
  compatible_with_warnings: 'warn',
  partial: 'warn',
  incompatible: 'danger',
  unavailable: 'neutral',
};

function download(filename: string, data: unknown): void {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // Download is unavailable in this environment; the data is still visible on screen.
  }
}

const chips = (items: string[], badge = 'neutral') =>
  items.length === 0 ? <span className="muted">none</span> : items.map((f) => <span key={f} className={`badge ${badge}`} style={{ marginRight: '0.25rem' }}>{f}</span>);

function ResultCard({ r, canRaw }: { r: ValidationResultItem; canRaw: boolean }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className={`isp-card${r.overallStatus === 'incompatible' ? ' error' : ''}`}>
      <div className="step-head">
        <h3 style={{ margin: 0 }}>{r.endpoint} <span className="mono muted">{r.resourceKey ?? `${r.zone ?? ''}${r.domain ? `/${r.domain}/${r.recordType}` : ''}`}</span></h3>
        <span className={`badge ${STATUS_BADGE[r.overallStatus]}`}>{r.overallStatus.replace(/_/g, ' ')}</span>
        <span className="badge neutral">{r.sourceMode}</span>
      </div>
      <div className="path">
        <div className="seg"><span className="seg-label">Schema</span>{r.schemaCompatible ? 'compatible' : 'incompatible'}</div>
        <div className="seg"><span className="seg-label">Adapter</span>{r.adapterCompatible ? 'compatible' : 'incompatible'}</div>
        <div className="seg"><span className="seg-label">Answer groups</span>{r.answerGroupsPresent ? 'present' : 'none'}</div>
        <div className="seg"><span className="seg-label">Feed-controlled metadata</span>{r.feedControlledMetadataPresent ? 'present' : 'none'}</div>
        <div className="seg"><span className="seg-label">ECS</span>{r.ecs.present ? (r.ecs.enabled ? 'enabled' : 'present (off)') : 'not present'}</div>
        <div className="seg"><span className="seg-label">Raw checksum</span><span className="mono">{r.rawChecksum || '—'}</span></div>
      </div>
      <div className="kv"><span>Supported filters</span><span>{chips(r.supportedFilters, 'ok')}</span></div>
      <div className="kv"><span>Unsupported filters</span><span>{chips(r.unsupportedFilters, 'danger')}</span></div>
      <div className="kv"><span>Unknown metadata fields</span><span>{chips(r.unknownMetadataFields, 'warn')}</span></div>
      <div className="kv"><span>Unexpected fields</span><span>{chips(r.unexpectedFields, 'warn')}</span></div>
      <div className="kv"><span>Missing expected fields</span><span>{chips(r.missingExpectedFields, 'danger')}</span></div>
      {r.fieldTypeMismatches.length > 0 && (
        <div className="kv"><span>Type mismatches</span><span>{r.fieldTypeMismatches.map((m) => <span key={m.path} className="badge warn" style={{ marginRight: '0.25rem' }}>{m.path}: {m.expected}≠{m.actual}</span>)}</span></div>
      )}
      <div className="notice info" style={{ marginTop: '0.4rem' }}>
        <b>Fixture comparison.</b> {r.fixtureComparison.matches ? 'Live matches the synthetic fixture model.' : 'Live diverges from the synthetic fixture model.'}{' '}
        {r.fixtureComparison.provisionalFixtureFields.length > 0 && `Provisional fixture fields not in live: ${r.fixtureComparison.provisionalFixtureFields.join(', ')}. `}
        {r.fixtureComparison.liveOnlyFields.length > 0 && `Live-only fields: ${r.fixtureComparison.liveOnlyFields.join(', ')}.`}
      </div>
      {r.warnings.length > 0 && <ul className="notes">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        <button className="ghost" onClick={() => download(`validation-${r.endpoint}-${r.rawChecksum || 'result'}.json`, r)}>Export sanitised report</button>
        {canRaw && r.fixtureCandidate && (
          <button className="ghost" onClick={() => download(`fixture-candidate-${r.endpoint}.json`, r.fixtureCandidate)}>Generate sanitised fixture candidate</button>
        )}
        {canRaw && r.sanitisedSample !== undefined && (
          <button className="ghost" onClick={() => setShowRaw((s) => !s)}>{showRaw ? 'Hide' : 'Show'} sanitised raw</button>
        )}
      </div>
      {showRaw && r.sanitisedSample !== undefined && (
        <pre className="mono" style={{ fontSize: '0.72rem', overflowX: 'auto', marginTop: '0.4rem' }}>{JSON.stringify(r.sanitisedSample, null, 2)}</pre>
      )}
      {r.fixtureCandidate && canRaw && (
        <div className="notice warn" style={{ marginTop: '0.4rem' }}>
          Fixture candidate requires operator review before use: {r.fixtureCandidate.provenance.reviewRequired.join('; ') || 'no flagged fields'}.
        </div>
      )}
    </div>
  );
}

export function ValidationNs1() {
  const { hasPermission } = useAuth();
  const canView = hasPermission('ns1.detail.read');
  const canRun = hasPermission('validation.run');
  const canRaw = hasPermission('ns1.raw.read');

  const [zone, setZone] = useState('rte.ie');
  const [domain, setDomain] = useState('live.rte.ie');
  const [recordType, setRecordType] = useState('A');
  const [includeActivity, setIncludeActivity] = useState(false);
  const [includeRaw, setIncludeRaw] = useState(canRaw);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ValidationResultItem[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [history, setHistory] = useState<ValidationResultItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.validationResults({ limit: 20 });
      setHistory(res.items ?? []);
      setMode(res.mode ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load validation history.');
    }
  }, []);

  useEffect(() => {
    if (canView) void loadHistory();
  }, [canView, loadHistory]);

  const run = () => {
    setRunning(true);
    setError(null);
    void (async () => {
      try {
        const res = await api.validationRun({ zone, domain: domain || undefined, recordType: recordType || undefined, includeActivity, includeRaw });
        setResults(res.results ?? []);
        setMode(res.mode);
        await loadHistory();
      } catch (e) {
        setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Validation run failed.');
      } finally {
        setRunning(false);
      }
    })();
  };

  if (!canView) {
    return (
      <div>
        <div className="page-head"><h1>NS1 Validation</h1></div>
        <div className="notice info">Validation results require the Viewing Engineer role.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1>NS1 Live Validation</h1>
        <p>Validate live or mock NS1 data against RADAR&apos;s runtime schemas, adapter and synthetic fixtures.</p>
      </div>

      <div className="notice danger"><b>Validation is read-only. RADAR has not modified NS1.</b></div>
      {mode && <div className="notice info">Source mode: <b>{mode}</b>. {mode === 'live' ? 'Querying the real NS1 account (read-only).' : 'Using fixture-backed mock data.'}</div>}
      {error && <div className="notice danger">{error}</div>}

      <div className="card">
        <div className="grid cols-3">
          <label className="field">Zone<input value={zone} onChange={(e) => setZone(e.target.value)} /></label>
          <label className="field">Domain (optional)<input value={domain} onChange={(e) => setDomain(e.target.value)} /></label>
          <label className="field">Record type (optional)<input value={recordType} onChange={(e) => setRecordType(e.target.value)} /></label>
        </div>
        <div className="live-controls">
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" checked={includeActivity} onChange={(e) => setIncludeActivity(e.target.checked)} /> Include activity</label>
          {canRaw && <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.3rem' }}><input type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} /> Include sanitised raw</label>}
          <span className="spacer" />
          {canRun ? (
            <button onClick={run} disabled={running || !zone}>{running ? 'Validating…' : 'Run validation'}</button>
          ) : (
            <span className="muted">Running validation requires the <code>validation.run</code> permission.</span>
          )}
        </div>
      </div>

      {results.map((r, i) => <ResultCard key={`run-${i}`} r={r} canRaw={canRaw} />)}

      <div className="card">
        <h3>Recent validation results</h3>
        {history.length === 0 ? (
          <div className="muted">No validation results yet.</div>
        ) : (
          <div className="matrix-wrap">
            <table className="matrix">
              <thead><tr><th>When</th><th>Endpoint</th><th>Target</th><th>Mode</th><th>Status</th><th>Unsupported</th></tr></thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>{r.ranAt ? new Date(r.ranAt).toLocaleString() : '—'}</td>
                    <td>{r.endpoint}</td>
                    <td className="mono">{r.zone}{r.domain ? `/${r.domain}/${r.recordType}` : ''}</td>
                    <td>{r.sourceMode}</td>
                    <td><span className={`badge ${STATUS_BADGE[r.overallStatus]}`}>{r.overallStatus.replace(/_/g, ' ')}</span></td>
                    <td className="muted">{r.unsupportedFilters.join(', ') || '—'}</td>
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

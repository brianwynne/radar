// Create / clone test record — RADAR's ONLY write to NS1, deliberately a distinct, clearly-labelled
// operator surface (not mixed into the read-only views). Two modes:
//   • Create — build a record from scratch.
//   • Clone  — copy an existing record's steering chain (e.g. livebase.nsone.rte.ie) onto the test
//              target, optionally overriding the TTL, so you can test shed behaviour safely.
// Flow either way: fill → Preview (a pure dry-run showing the exact NS1 request) → Confirm & create.
// Guarded server-side: engineer-only, default-off, allow-list + protected denylist. Nothing is
// written until Confirm.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CreatableRecordType, RecordCapability, RecordCreateResult, RecordPlan } from '../api/types';

type Mode = 'create' | 'clone';

export function CreateTestRecord() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('ns1.record.create');

  const [cap, setCap] = useState<RecordCapability | null>(null);
  const [mode, setMode] = useState<Mode>('create');

  // Target (both modes)
  const [zone, setZone] = useState('livetest.rte.ie');
  const [domain, setDomain] = useState('livetest.rte.ie');
  const [ttl, setTtl] = useState(30);
  // Create-only
  const [type, setType] = useState<CreatableRecordType>('A');
  const [answers, setAnswers] = useState('185.54.104.4');
  // Clone-only source
  const [srcZone, setSrcZone] = useState('nsone.rte.ie');
  const [srcDomain, setSrcDomain] = useState('livebase.nsone.rte.ie');
  const [srcType, setSrcType] = useState<CreatableRecordType>('CNAME');
  const [ttlOverride, setTtlOverride] = useState(true);

  const [plan, setPlan] = useState<RecordPlan | null>(null);
  const [result, setResult] = useState<RecordCreateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    api.recordCapability().then(setCap).catch(() => setCap(null));
  }, [canWrite]);

  // Any edit invalidates a prior preview/result so you can never confirm a stale plan.
  const invalidate = () => { setPlan(null); setResult(null); setError(null); };
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); invalidate(); };
  const createInput = () => ({ zone: zone.trim(), domain: domain.trim(), type, answers: answers.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean), ttl: Number(ttl) });
  const cloneInput = () => ({ source: { zone: srcZone.trim(), domain: srcDomain.trim(), type: srcType }, target: { zone: zone.trim(), domain: domain.trim(), ...(ttlOverride ? { ttl: Number(ttl) } : {}) } });

  async function preview() {
    setBusy(true); setError(null); setResult(null);
    try { setPlan(mode === 'create' ? await api.recordPlan(createInput()) : await api.recordClonePlan(cloneInput())); }
    catch (e) { setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Preview failed.'); }
    finally { setBusy(false); }
  }
  async function confirmCreate() {
    setBusy(true); setError(null);
    try { setResult(mode === 'create' ? await api.recordApply(createInput()) : await api.recordCloneApply(cloneInput())); setPlan(null); }
    catch (e) { setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Create failed.'); }
    finally { setBusy(false); }
  }

  if (!canWrite) return <div className="page"><h1>Create test record</h1><div className="notice danger">You do not have permission to create records (engineer only).</div></div>;

  const field = (label: string, node: React.ReactNode) => (
    <label className="field" style={{ display: 'block', marginBottom: '0.6rem' }}><span style={{ display: 'block', fontSize: '0.75rem' }} className="muted">{label}</span>{node}</label>
  );

  return (
    <div className="page ctr">
      <div className="section-head" style={{ alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Create test record <span className="badge warn">WRITE · NS1</span></h1>
        <div className="rv-viewtoggle" role="tablist">
          <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'on' : ''} onClick={() => { setMode('create'); invalidate(); }}>Create</button>
          <button role="tab" aria-selected={mode === 'clone'} className={mode === 'clone' ? 'on' : ''} onClick={() => { setMode('clone'); invalidate(); }}>Clone existing</button>
        </div>
      </div>
      <div className="notice warn">
        This is RADAR’s <b>only</b> write to NS1. It’s engineer-gated, audited, default-off, and restricted to an <b>allow-list</b> — a slip can’t touch a live record. <b>Nothing is sent until you press Confirm & create.</b>
      </div>

      {cap && !cap.writeEnabled && (
        <div className="notice danger">The create path is <b>disabled</b> on the server (<span className="mono">NS1_WRITE_ENABLED</span> is off, or NS1 isn’t live with a write key). You can still preview the exact request, but Confirm will be refused.</div>
      )}
      {cap && <div className="muted" style={{ fontSize: '0.8rem', margin: '0.3rem 0 0.8rem' }}>Allow-list: {cap.allowList.map((a) => <span key={a} className="chip mono" style={{ marginRight: '0.3rem' }}>{a}</span>)}</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          {mode === 'clone' && (
            <>
              <h2 style={{ marginTop: 0 }}>Source (cloned from)</h2>
              {field('Source zone', <input value={srcZone} onChange={(e) => set(setSrcZone)(e.target.value)} className="mono" placeholder="nsone.rte.ie" />)}
              {field('Source record name', <input value={srcDomain} onChange={(e) => set(setSrcDomain)(e.target.value)} className="mono" placeholder="livebase.nsone.rte.ie" />)}
              {field('Source type', (
                <select value={srcType} onChange={(e) => set(setSrcType)(e.target.value as CreatableRecordType)}>
                  <option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option>
                </select>
              ))}
              <div className="muted" style={{ fontSize: '0.72rem', marginBottom: '0.6rem' }}>The source’s answers + steering filter chain are copied to the target.</div>
            </>
          )}
          <h2 style={{ marginTop: mode === 'clone' ? '0.5rem' : 0 }}>Target (created)</h2>
          {field('Zone', <input value={zone} onChange={(e) => set(setZone)(e.target.value)} className="mono" placeholder="livetest.rte.ie" />)}
          {field('Record name (domain)', <input value={domain} onChange={(e) => set(setDomain)(e.target.value)} className="mono" placeholder="livetest.rte.ie" />)}
          {mode === 'create' && field('Type', (
            <select value={type} onChange={(e) => set(setType)(e.target.value as CreatableRecordType)}>
              <option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option>
            </select>
          ))}
          {mode === 'create' && field(type === 'CNAME' ? 'Target (one hostname)' : 'Answers (space/comma-separated)', <input value={answers} onChange={(e) => set(setAnswers)(e.target.value)} className="mono" placeholder={type === 'CNAME' ? 'liveedge.rte.ie' : '185.54.104.4 185.54.105.4'} />)}
          {mode === 'clone' && (
            <label className="switch" style={{ display: 'block', marginBottom: '0.5rem' }} title="Override the cloned TTL (e.g. drop to 30s to test faster steering)">
              <input type="checkbox" checked={ttlOverride} onChange={(e) => set(setTtlOverride)(e.target.checked)} /> Override TTL (else inherit the source’s)
            </label>
          )}
          {(mode === 'create' || ttlOverride) && field('TTL (seconds)', <input type="number" min={1} max={604800} value={ttl} onChange={(e) => set(setTtl)(Number(e.target.value))} className="mono" style={{ width: '8rem' }} />)}
          <button className="primary" onClick={preview} disabled={busy}>{busy && !plan ? 'Previewing…' : 'Preview'}</button>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Dry-run</h2>
          {error && <div className="notice danger">{error}</div>}
          {result && (
            <div className="notice ok">
              <b>Done.</b> {result.provenance.notice} <span className="muted">({new Date(result.provenance.appliedAt).toLocaleTimeString()})</span>
            </div>
          )}
          {!plan && !result && <div className="muted">Fill the form and press <b>Preview</b> to see the exact NS1 request before anything is sent.</div>}
          {plan && (
            <>
              <div className={`notice ${plan.allowed ? 'ok' : 'danger'}`}>
                {plan.allowed ? <><b>Allowed.</b> This will create <span className="mono">{plan.target.domain}</span> ({plan.target.type}).</> : <><b>Blocked.</b> {plan.blockedReason}</>}
              </div>
              {plan.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}
              <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>Exact NS1 request</div>
              <pre className="ctr-payload mono"><b>{plan.request.method}</b> {plan.request.path}{'\n'}{JSON.stringify(plan.request.body, null, 2)}</pre>
              {plan.allowed && (
                <button className="danger" onClick={confirmCreate} disabled={busy || (cap ? !cap.writeEnabled : false)} title={cap && !cap.writeEnabled ? 'The create path is disabled on the server.' : 'Send this exact request to NS1'}>
                  {busy ? 'Creating…' : 'Confirm & create'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

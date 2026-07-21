// Create / clone record — RADAR's ONLY write to NS1, deliberately a distinct, clearly-labelled
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
import { RecordFriendlyEditor } from '../features/RecordFriendlyEditor';
import type { CreatableRecordType, RecordCapability, RecordCreateResult, RecordPlan } from '../api/types';

type Mode = 'create' | 'clone';

export interface CreateRecordPanelProps {
  /** The selected zone — the create target (pre-selected in the zone dropdown). */
  targetZone: string;
  /** Available zones for the target dropdown (from the explorer). */
  zones?: string[];
  initialMode?: Mode;
  /** Clone source (from the explorer's selected record). */
  source?: { zone: string; domain: string; type: CreatableRecordType };
  /** Called after a successful create/clone so the parent can refresh the zone's records. */
  onDone?: () => void;
  /** Close the panel. */
  onClose?: () => void;
}

// Guarded NS1 create/clone record form, nested inside the selected zone in the NS1 Explorer. Two
// modes: Create (from scratch) and Clone (copy an existing record's steering chain, cross-zone).
// Flow: fill → Preview (pure dry-run, exact NS1 request) → Confirm & create. Server-guarded:
// engineer-only, default-off, allow-list + protected denylist. Nothing is written until Confirm.
export function CreateRecordPanel({ targetZone, zones, initialMode, source, onDone, onClose }: CreateRecordPanelProps) {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('ns1.record.create');

  const [cap, setCap] = useState<RecordCapability | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode ?? 'create');

  // Target (both modes) — defaults to the selected zone.
  const [zone, setZone] = useState(targetZone);
  const [domain, setDomain] = useState(targetZone);
  const [ttl, setTtl] = useState(30);
  // Create-only
  const [type, setType] = useState<CreatableRecordType>('A');
  const [answers, setAnswers] = useState('185.54.104.4');
  // Clone-only source
  const [srcZone, setSrcZone] = useState(source?.zone ?? 'nsone.rte.ie');
  const [srcDomain, setSrcDomain] = useState(source?.domain ?? 'livebase.nsone.rte.ie');
  const [srcType, setSrcType] = useState<CreatableRecordType>(source?.type ?? 'CNAME');
  const [ttlOverride, setTtlOverride] = useState(true);

  const [plan, setPlan] = useState<RecordPlan | null>(null);
  const [result, setResult] = useState<RecordCreateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  // A friendly-edited record body — once set, preview/confirm use it (via the clone-with-record path).
  const [editedBody, setEditedBody] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!canWrite) return;
    api.recordCapability().then(setCap).catch(() => setCap(null));
  }, [canWrite]);

  async function toggleGate(enabled: boolean) {
    setGateBusy(true); setGateError(null);
    try { setCap(await api.recordSetWriteEnabled(enabled)); }
    catch (e) { setGateError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not change the write gate.'); }
    finally { setGateBusy(false); }
  }

  // Any edit invalidates a prior preview/result so you can never confirm a stale plan.
  const invalidate = () => { setPlan(null); setResult(null); setError(null); };
  // A change to the record's shape (mode / type / answers) also drops a stale friendly-edited body;
  // target changes (zone/domain/ttl) keep it.
  const invalidateAll = () => { invalidate(); setEditedBody(null); setEditing(false); };
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); invalidate(); };
  const setShape = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); invalidateAll(); };
  const createInput = () => ({ zone: zone.trim(), domain: domain.trim(), type, answers: answers.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean), ttl: Number(ttl) });
  const cloneInput = () => ({ source: { zone: srcZone.trim(), domain: srcDomain.trim(), type: srcType }, target: { zone: zone.trim(), domain: domain.trim(), ...(ttlOverride ? { ttl: Number(ttl) } : {}) } });
  const editTarget = () => ({ zone: zone.trim(), domain: domain.trim() }); // ttl comes from the edited body

  async function preview() {
    setBusy(true); setError(null); setResult(null);
    try {
      setPlan(editedBody
        ? await api.recordClonePlan({ record: editedBody, target: editTarget() })
        : mode === 'create' ? await api.recordPlan(createInput()) : await api.recordClonePlan(cloneInput()));
    } catch (e) { setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Preview failed.'); }
    finally { setBusy(false); }
  }
  async function confirmCreate() {
    setBusy(true); setError(null);
    try {
      setResult(editedBody
        ? await api.recordCloneApply({ record: editedBody, target: editTarget() })
        : mode === 'create' ? await api.recordApply(createInput()) : await api.recordCloneApply(cloneInput()));
      setPlan(null); onDone?.();
    } catch (e) { setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Create failed.'); }
    finally { setBusy(false); }
  }
  // Apply friendly edits → re-preview from the edited body.
  async function applyEdits(body: Record<string, unknown>) {
    setEditedBody(body); setEditing(false); setBusy(true); setError(null); setResult(null);
    try { setPlan(await api.recordClonePlan({ record: body, target: editTarget() })); }
    catch (e) { setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Preview failed.'); }
    finally { setBusy(false); }
  }

  if (!canWrite) return null;

  const field = (label: string, node: React.ReactNode) => (
    <label className="field" style={{ display: 'block', marginBottom: '0.6rem' }}><span style={{ display: 'block', fontSize: '0.75rem' }} className="muted">{label}</span>{node}</label>
  );

  return (
    <div className="ctr ns1-create-panel">
      <div className="section-head" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Create record in {targetZone} <span className="badge warn">WRITE · NS1</span></h3>
        <div className="rv-viewtoggle" role="tablist" style={{ marginLeft: '0.5rem' }}>
          <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'on' : ''} onClick={() => { setMode('create'); invalidateAll(); }}>Create</button>
          <button role="tab" aria-selected={mode === 'clone'} className={mode === 'clone' ? 'on' : ''} onClick={() => { setMode('clone'); invalidateAll(); }}>Clone existing</button>
        </div>
        {onClose && <button className="ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>}
      </div>
      <div className="notice warn">
        This is RADAR’s <b>only</b> write to NS1. It’s engineer-gated, audited, and restricted to an <b>allow-list</b> — a slip can’t touch a live record. <b>Nothing is sent until you press Confirm & create.</b>
      </div>

      {cap && (
        <div className="ctr-gate">
          <label className="switch" title="Enable/disable the guarded NS1 write path (NS1_WRITE_ENABLED). Persisted + audited.">
            <input type="checkbox" checked={cap.writeEnabled} disabled={gateBusy} onChange={(e) => toggleGate(e.target.checked)} /> Enable NS1 writes <span className="mono muted">(NS1_WRITE_ENABLED)</span>
          </label>
          {cap.writeEnabled && cap.writeReady === false && (
            <span className="muted" style={{ fontSize: '0.78rem' }}> · gate on, but NS1 isn’t live with a write key — set it on <b>Integrations</b>. Confirm will be refused until then.</span>
          )}
          {gateError && <span className="notice danger" style={{ padding: '0.1rem 0.4rem' }}>{gateError}</span>}
        </div>
      )}
      {cap && !cap.writeEnabled && (
        <div className="notice info" style={{ marginTop: '0.4rem' }}>The write path is <b>off</b>. Flip the switch above to enable it. You can still preview the exact request; Confirm is refused while off.</div>
      )}
      {cap && <div className="muted" style={{ fontSize: '0.8rem', margin: '0.3rem 0 0.8rem' }}>Allow-list: {cap.allowList.map((a) => <span key={a} className="chip mono" style={{ marginRight: '0.3rem' }}>{a}</span>)}</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          {mode === 'clone' && (
            <>
              <h2 style={{ marginTop: 0 }}>Source (cloned from)</h2>
              {field('Source zone', <input value={srcZone} onChange={(e) => setShape(setSrcZone)(e.target.value)} className="mono" placeholder="nsone.rte.ie" />)}
              {field('Source record name', <input value={srcDomain} onChange={(e) => setShape(setSrcDomain)(e.target.value)} className="mono" placeholder="livebase.nsone.rte.ie" />)}
              {field('Source type', (
                <select value={srcType} onChange={(e) => setShape(setSrcType)(e.target.value as CreatableRecordType)}>
                  <option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option>
                </select>
              ))}
              <div className="muted" style={{ fontSize: '0.72rem', marginBottom: '0.6rem' }}>Reads the source record (any zone) and <b>copies</b> its answers + steering filter chain into the target zone below — a cross-zone copy, not NS1’s same-zone clone.</div>
            </>
          )}
          <h2 style={{ marginTop: mode === 'clone' ? '0.5rem' : 0 }}>Target (created)</h2>
          {field('Zone', zones && zones.length
            ? <select value={zone} onChange={(e) => set(setZone)(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>
            : <input value={zone} onChange={(e) => set(setZone)(e.target.value)} className="mono" placeholder="livetest.rte.ie" />)}
          {field('Record name (domain)', <input value={domain} onChange={(e) => set(setDomain)(e.target.value)} className="mono" placeholder="livetest.rte.ie" />)}
          {mode === 'create' && field('Type', (
            <select value={type} onChange={(e) => setShape(setType)(e.target.value as CreatableRecordType)}>
              <option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option>
            </select>
          ))}
          {mode === 'create' && field(type === 'CNAME' ? 'Target (one hostname)' : 'Answers (space/comma-separated)', <input value={answers} onChange={(e) => setShape(setAnswers)(e.target.value)} className="mono" placeholder={type === 'CNAME' ? 'liveedge.rte.ie' : '185.54.104.4 185.54.105.4'} />)}
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
          {!plan && !result && !editing && <div className="muted">Fill the form and press <b>Preview</b> to see the exact NS1 request before anything is sent.</div>}
          {editing && plan && (
            <RecordFriendlyEditor initial={editedBody ?? plan.request.body} onApply={applyEdits} onCancel={() => setEditing(false)} />
          )}
          {plan && !editing && (
            <>
              <div className={`notice ${plan.allowed ? 'ok' : 'danger'}`}>
                {plan.allowed ? <><b>Allowed.</b> This will create <span className="mono">{plan.target.domain}</span> ({plan.target.type}){editedBody ? ' — with your edits' : ''}.</> : <><b>Blocked.</b> {plan.blockedReason}</>}
              </div>
              {plan.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}
              <div className="ctr-run-actions">
                {plan.allowed && (
                  <button className="ghost" onClick={() => setEditing(true)} title="Edit the record in a friendly interface (answers, weights, resolved ASNs, countries) — not raw JSON">
                    Edit record
                  </button>
                )}
              </div>
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

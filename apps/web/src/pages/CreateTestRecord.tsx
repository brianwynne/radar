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
import type { CreatableRecordType, RecordCapability, RecordCreateResult, RecordPlan, SnapshotSummary } from '../api/types';

type Mode = 'create' | 'clone';
const SNAP_ZONE = '__snapshots__'; // pseudo source-zone: pick a snapshot as the clone source
const NEW_NAME = '__new__'; // record-name dropdown sentinel: type a brand-new name

export interface CreateRecordPanelProps {
  /** The selected zone — the create target (pre-selected in the zone dropdown). */
  targetZone: string;
  /** Available zones for the target dropdown (from the explorer). */
  zones?: string[];
  initialMode?: Mode;
  /** Clone source (from the explorer's selected record). */
  source?: { zone: string; domain: string; type: CreatableRecordType };
  /** A record body to seed from (e.g. a snapshot's payload) — the panel opens ready to edit/preview it. */
  initialRecord?: Record<string, unknown>;
  /** Called after a successful create/clone so the parent can refresh the zone's records. */
  onDone?: () => void;
  /** Close the panel. */
  onClose?: () => void;
}

// Guarded NS1 create/clone record form, nested inside the selected zone in the NS1 Explorer. Two
// modes: Create (from scratch) and Clone (copy an existing record's steering chain, cross-zone).
// Flow: fill → Preview (pure dry-run, exact NS1 request) → Confirm & create. Server-guarded:
// engineer-only, default-off, allow-list + protected denylist. Nothing is written until Confirm.
export function CreateRecordPanel({ targetZone, zones, initialMode, source, initialRecord, onDone, onClose }: CreateRecordPanelProps) {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('ns1.record.create');
  const supplied = !!initialRecord; // seeded from a snapshot / supplied record body

  const [cap, setCap] = useState<RecordCapability | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode ?? 'create');

  // Target (both modes) — defaults to the selected zone.
  const [zone, setZone] = useState(targetZone);
  const [domain, setDomain] = useState(''); // a record UNDER the zone — never the apex; typed/picked in
  const [ttl, setTtl] = useState(30);
  // Create-only
  const [type] = useState<CreatableRecordType>('CNAME'); // only CNAME records are creatable
  const [answers, setAnswers] = useState('liveedge.rte.ie'); // CNAME target (a hostname, not an IP)
  // Clone-only source
  const [srcZone, setSrcZone] = useState(source?.zone ?? 'nsone.rte.ie');
  const [srcDomain, setSrcDomain] = useState(source?.domain ?? 'livebase.nsone.rte.ie');
  // Only CNAME steering records are cloned, so the source type is fixed (no selector).
  const [srcType] = useState<CreatableRecordType>(source?.type ?? 'CNAME');
  const [ttlOverride, setTtlOverride] = useState(true);

  const [plan, setPlan] = useState<RecordPlan | null>(null);
  const [result, setResult] = useState<RecordCreateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  // A friendly-edited (or supplied) record body — once set, preview/confirm use it (clone-with-record).
  const [editedBody, setEditedBody] = useState<Record<string, unknown> | null>(() => initialRecord ?? null);
  const [editing, setEditing] = useState(false);

  // CNAME records in the selected SOURCE zone (clone mode) — the source-record dropdown.
  const [srcRecords, setSrcRecords] = useState<string[]>([]);
  const [snaps, setSnaps] = useState<SnapshotSummary[]>([]); // when the "Snapshots" source is chosen
  const [tgtRecords, setTgtRecords] = useState<string[]>([]); // target-zone records → name dropdown
  const [refresh, setRefresh] = useState(0); // bump to force a zone-records refetch
  const bump = () => setRefresh((n) => n + 1);

  useEffect(() => {
    if (!canWrite) return;
    api.recordCapability().then(setCap).catch(() => setCap(null));
  }, [canWrite]);

  // Snapshots list (only when the "Snapshots" source zone is chosen).
  useEffect(() => {
    if (mode !== 'clone' || supplied || srcZone !== SNAP_ZONE) return;
    let live = true;
    api.allSnapshots().then((r) => { if (live) setSnaps(r.snapshots); }).catch(() => { if (live) setSnaps([]); });
    return () => { live = false; };
  }, [mode, supplied, srcZone]);

  // Target-zone existing records → a datalist of suggestions on the record-name field.
  useEffect(() => {
    if (!zone.trim()) { setTgtRecords([]); return; }
    let live = true;
    api.zone(zone.trim()).then((r) => {
      if (!live) return;
      const zoneObj = (r.zone ?? {}) as { records?: unknown[] };
      setTgtRecords((Array.isArray(zoneObj.records) ? zoneObj.records : []).map((x) => (x as { domain?: string }).domain ?? '').filter(Boolean));
    }).catch(() => { if (live) setTgtRecords([]); });
    return () => { live = false; };
  }, [zone, refresh]);

  // Load a snapshot's captured record body as the clone source.
  async function selectSnapshot(id: string) {
    setSrcDomain(id); setPlan(null); setResult(null); setError(null);
    try { const { snapshot } = await api.snapshot(id); setEditedBody(snapshot.rawPayload as Record<string, unknown>); }
    catch (e) { setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load the snapshot.'); }
  }

  useEffect(() => {
    if (mode !== 'clone' || supplied || !srcZone.trim() || srcZone === SNAP_ZONE) { setSrcRecords([]); return; }
    let live = true;
    api.zone(srcZone.trim())
      .then((r) => {
        if (!live) return;
        const zoneObj = (r.zone ?? {}) as { records?: unknown[] };
        const names = (Array.isArray(zoneObj.records) ? zoneObj.records : [])
          .map((x) => x as { domain?: string; type?: string })
          .filter((x) => x.domain && String(x.type).toUpperCase() === 'CNAME')
          .map((x) => x.domain as string);
        setSrcRecords(names);
        // Keep the current source record if still present, else pick the first (and drop a stale plan).
        if (names.length && !names.includes(srcDomain)) { setSrcDomain(names[0]); setPlan(null); setEditedBody(null); setEditing(false); }
      })
      .catch(() => { if (live) setSrcRecords([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, supplied, srcZone, refresh]);

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
      setPlan(null); bump(); onDone?.();
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
        <h3 style={{ margin: 0 }}>{supplied ? 'Create record from snapshot' : `Create record in ${targetZone}`} <span className="badge warn">WRITE · NS1</span></h3>
        {!supplied && (
          <div className="rv-viewtoggle" role="tablist" style={{ marginLeft: '0.5rem' }}>
            <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'on' : ''} onClick={() => { setMode('create'); invalidateAll(); }}>Create</button>
            <button role="tab" aria-selected={mode === 'clone'} className={mode === 'clone' ? 'on' : ''} onClick={() => { setMode('clone'); invalidateAll(); }}>Clone existing</button>
          </div>
        )}
        {onClose && <button className="ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>}
      </div>
      <div className="notice warn">
        This is RADAR’s <b>only</b> write to NS1. It’s engineer-gated, audited, and restricted to an <b>allow-list</b> — a slip can’t touch a live record. <b>Nothing is sent until you press Confirm & create.</b>
      </div>

      {cap && (
        <div className="ctr-gate">
          <label className="switch" title="Enable/disable the guarded NS1 write path (NS1_WRITE_ENABLED). Persisted + audited.">
            <input type="checkbox" checked={cap.writeEnabled} disabled={gateBusy} onChange={(e) => toggleGate(e.target.checked)} /> Enable NS1 writes <span className="mono muted">(resets to off on restart)</span>
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
          {supplied && <div className="muted" style={{ fontSize: '0.72rem', marginBottom: '0.6rem' }}>Record body supplied — choose the target zone/name below, then <b>Edit record</b> to adjust (weights, ASNs, TTL) or <b>Preview</b> to validate.</div>}
          {!supplied && mode === 'clone' && (
            <>
              <h2 style={{ marginTop: 0 }}>Source (cloned from)</h2>
              {field('Source', (
                <select value={srcZone} onChange={(e) => { setShape(setSrcZone)(e.target.value); bump(); }}>
                  <option value={SNAP_ZONE}>📷 Snapshots</option>
                  {(zones ?? []).map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              ))}
              {srcZone === SNAP_ZONE
                ? field('Snapshot', snaps.length
                    ? <select value={srcDomain} onChange={(e) => selectSnapshot(e.target.value)}>
                        <option value="">Select a snapshot…</option>
                        {snaps.map((s) => <option key={s.id} value={s.id}>{s.resourceKey}{s.label ? ` · ${s.label}` : ''} — {new Date(s.retrievedAt ?? s.createdAt).toLocaleDateString()}</option>)}
                      </select>
                    : <span className="muted">No snapshots captured yet.</span>)
                : field('Source record (CNAME)', srcRecords.length
                    ? <select value={srcRecords.includes(srcDomain) ? srcDomain : ''} onChange={(e) => setShape(setSrcDomain)(e.target.value)}>
                        {!srcRecords.includes(srcDomain) && <option value="">Select a record…</option>}
                        {srcRecords.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    : <span className="muted">{srcZone.trim() ? 'No CNAME records in this zone.' : 'Pick a source zone first.'}</span>)}
              <div className="muted" style={{ fontSize: '0.72rem', marginBottom: '0.6rem' }}>Copies the source’s answers + steering filter chain into the target zone below — a cross-zone copy, not NS1’s same-zone clone. The source can be a live record or a <b>snapshot</b>.</div>
            </>
          )}
          <h2 style={{ marginTop: !supplied && mode === 'clone' ? '0.5rem' : 0 }}>Target (created)</h2>
          {field('Zone', zones && zones.length
            ? <select value={zone} onChange={(e) => { set(setZone)(e.target.value); bump(); }}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>
            : <input value={zone} onChange={(e) => set(setZone)(e.target.value)} className="mono" placeholder="livetest.rte.ie" />)}
          {field('Record name (domain)', tgtRecords.length ? (
            <>
              <select value={tgtRecords.includes(domain) ? domain : NEW_NAME} onChange={(e) => { const v = e.target.value; set(setDomain)(v === NEW_NAME ? '' : v); }}>
                <option value={NEW_NAME}>＋ New record name…</option>
                {tgtRecords.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {!tgtRecords.includes(domain) && (
                <input value={domain} onChange={(e) => set(setDomain)(e.target.value)} className="mono" placeholder={`nstest.${zone}`} style={{ marginTop: '0.3rem' }} autoFocus />
              )}
            </>
          ) : (
            <input value={domain} onChange={(e) => set(setDomain)(e.target.value)} className="mono" placeholder={`nstest.${zone}`} />
          ))}
          {!supplied && mode === 'create' && field('Type', <input value="CNAME" readOnly className="mono" style={{ width: '8rem' }} title="Only CNAME records are creatable" />)}
          {!supplied && mode === 'create' && field('Target (one hostname)', <input value={answers} onChange={(e) => setShape(setAnswers)(e.target.value)} className="mono" placeholder="liveedge.rte.ie" />)}
          {!supplied && mode === 'clone' && (
            <label className="switch" style={{ display: 'block', marginBottom: '0.5rem' }} title="Override the cloned TTL (e.g. drop to 30s to test faster steering)">
              <input type="checkbox" checked={ttlOverride} onChange={(e) => set(setTtlOverride)(e.target.checked)} /> Override TTL (else inherit the source’s)
            </label>
          )}
          {!supplied && (mode === 'create' || ttlOverride) && field('TTL (seconds)', <input type="number" min={1} max={604800} value={ttl} onChange={(e) => set(setTtl)(Number(e.target.value))} className="mono" style={{ width: '8rem' }} />)}
          <div className="ctr-run-actions" style={{ display: 'flex', gap: '0.4rem' }}>
            <button className="primary" onClick={preview} disabled={busy}>{busy && !plan ? 'Previewing…' : 'Preview'}</button>
            {editedBody && !editing && <button className="ghost" onClick={() => setEditing(true)}>Edit record</button>}
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Dry-run</h2>
          {error && <div className="notice danger">{error}</div>}
          {result && (
            <div className="notice ok">
              <b>Done.</b> {result.provenance.notice} <span className="muted">({new Date(result.provenance.appliedAt).toLocaleTimeString()})</span>
            </div>
          )}
          {!plan && !result && !editing && !editedBody && <div className="muted">Fill the form and press <b>Preview</b> to see the exact NS1 request before anything is sent.</div>}
          {!plan && !result && !editing && editedBody && <div className="muted">A record body is loaded. Press <b>Preview</b> to validate it against the target, or <b>Edit record</b> to adjust it.</div>}
          {editing && (editedBody || plan) && (
            <RecordFriendlyEditor initial={editedBody ?? plan!.request.body} onApply={applyEdits} onCancel={() => setEditing(false)} />
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

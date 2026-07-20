// NS1 Explorer — read-only discovery and inspection across every record the API exposes.
// The selected record is URL-addressable (/explorer/:zone/:domain/:type), so Steering and
// Explain can deep-link into it. Raw JSON is gated on ns1.raw.read. GET-only throughout.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ProvenanceLine } from '../components/Provenance';
import { RecordEditor } from '../components/RecordEditor';
import { RecordConfigView } from '../features/RecordConfigView';
import { RecordWalkthrough } from '../features/RecordWalkthrough';
import { addRecent, getRecent, type RecordRef } from '../ns1/recent';
import { SnapshotsPanel } from '../features/Snapshots';
import { ExplainPanel, type ExplainScenario } from '../features/ExplainPanel';
import { IspSteeringOverview } from '../features/IspSteeringOverview';
import { AsnBreakdown } from '../features/AsnBreakdown';
import { ispToScenario, type Isp } from '../steering/isps';
import type { Ns1ActiveRecordResponse, Provenance } from '../api/types';

type View = 'config' | 'walkthrough' | 'normalised' | 'raw';
interface RecordSummary {
  domain: string;
  type: string;
}

// A bare /explorer lands in the primary zone, then on the currently-ACTIVE steering record
// (resolved live from live.rte.ie's CNAME). DEFAULT_RECORD is only a fallback if the active record
// can't be resolved.
const DEFAULT_ZONE = 'nsone.rte.ie';
const DEFAULT_RECORD = { domain: 'live.nsone.rte.ie', type: 'CNAME' };

function zoneName(z: unknown, i: number): string {
  return (z as { zone?: string }).zone ?? `zone-${i}`;
}

function extractRecords(zone: Record<string, unknown>): RecordSummary[] {
  const raw = Array.isArray(zone.records) ? zone.records : [];
  return raw
    .map((r) => r as { domain?: string; type?: string })
    .filter((r) => r.domain && r.type)
    .map((r) => ({ domain: r.domain as string, type: r.type as string }));
}

export function Ns1Explorer() {
  const { hasPermission } = useAuth();
  const canRaw = hasPermission('ns1.raw.read');
  const canExplain = hasPermission('dns.explain.read');
  const navigate = useNavigate();
  const location = useLocation();
  const { zone, domain, type } = useParams<{ zone: string; domain: string; type: string }>();

  // Steering / Dashboard deep-link here with a scenario to explain the selected record. Its
  // zone/domain/type identify the record; the scenario fields seed the inline Explain panel.
  const rawPrefill = (location.state as { prefill?: Partial<ExplainScenario> & { zone?: string; domain?: string; type?: string } } | null)?.prefill;
  const prefillMatches = Boolean(rawPrefill && rawPrefill.zone === zone && rawPrefill.domain === domain && rawPrefill.type === type);
  const [showExplain, setShowExplain] = useState(false);

  const [zones, setZones] = useState<string[] | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [records, setRecords] = useState<RecordSummary[] | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [view, setView] = useState<View>('config');
  const [editing, setEditing] = useState(false); // raw-view record editor (edit + Copy for NS1)
  const [payload, setPayload] = useState<{ provenance: Provenance; body: Record<string, unknown> } | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecordRef[]>(getRecent());

  // The currently-active steering record: live.rte.ie CNAMEs to it (resolved live via DNS). Polled
  // so a re-point (the active record switching) is detected while the page is open.
  const [activeRecord, setActiveRecord] = useState<Ns1ActiveRecordResponse | null>(null);
  const activeDomainRef = useRef<string | null>(null);
  const [activeChanged, setActiveChanged] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api.activeRecord().then((r) => {
        if (stop) return;
        setActiveRecord(r);
        const dom = r.active?.domain ?? null;
        if (activeDomainRef.current && dom && activeDomainRef.current !== dom) setActiveChanged({ from: activeDomainRef.current, to: dom });
        if (dom) activeDomainRef.current = dom;
      }).catch(() => { /* keep the last-known active record */ });
    void load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  // Zone list (once). With no zone selected, default into the primary zone if it's available.
  useEffect(() => {
    api
      .zones()
      .then((r) => {
        const names = r.zones.map(zoneName);
        setZones(names);
        if (!zone && names.includes(DEFAULT_ZONE)) navigate(`/explorer/${DEFAULT_ZONE}`, { replace: true });
      })
      .catch(() => setZonesError('Could not load zones.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Records within the selected zone.
  useEffect(() => {
    if (!zone) {
      setRecords(null);
      return;
    }
    let alive = true;
    setRecords(null);
    setRecordsError(null);
    api
      .zone(zone)
      .then((r) => alive && setRecords(extractRecords(r.zone)))
      .catch((e: unknown) => alive && setRecordsError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load records.'));
    return () => {
      alive = false;
    };
  }, [zone]);

  // Default landing record: within the primary zone with nothing selected, jump to the ACTIVE
  // steering record (resolved from live.rte.ie), or DEFAULT_RECORD if the active one can't be
  // resolved. Waits for both the records list and the active-record lookup.
  useEffect(() => {
    if (domain || type || zone !== DEFAULT_ZONE || !records) return;
    const act = activeRecord?.active;
    const target = act && act.zone === zone ? { domain: act.domain, type: act.type } : activeRecord ? DEFAULT_RECORD : null;
    if (target && records.some((r) => r.domain === target.domain && r.type === target.type)) {
      navigate(`/explorer/${zone}/${target.domain}/${target.type}`, { replace: true });
    }
  }, [zone, domain, type, records, activeRecord, navigate]);

  // Track the selected record in the recent list.
  useEffect(() => {
    if (zone && domain && type) setRecent(addRecent({ zone, domain, type }));
  }, [zone, domain, type]);

  // Selecting a record collapses Explain; arriving with a matching prefill opens it (and auto-runs).
  useEffect(() => {
    setShowExplain(prefillMatches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, domain, type, location.key]);

  // The selected record (normalised or raw).
  useEffect(() => {
    if (!zone || !domain || !type) {
      setPayload(null);
      return;
    }
    let active = true;
    setPayload(null);
    setRecordError(null);
    const useRaw = view === 'raw' && canRaw;
    const load = useRaw
      ? api.rawRecord(zone, domain, type).then((r) => ({ provenance: r.provenance, body: r.raw }))
      : api.record(zone, domain, type).then((r) => ({ provenance: r.provenance, body: r.record }));
    load
      .then((p) => active && setPayload(p))
      .catch((e: unknown) => active && setRecordError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load the record.'));
    return () => {
      active = false;
    };
  }, [zone, domain, type, view, canRaw]);

  const selectRecord = (r: RecordSummary) => navigate(`/explorer/${zone}/${r.domain}/${r.type}`);

  // Picking an ISP from the overview deep-links back into this record with that ISP's identity,
  // which opens and auto-runs the Explain panel for that subscriber (via the prefill effect above).
  const explainIsp = (isp: Isp) => {
    if (zone && domain && type) navigate(`/explorer/${zone}/${domain}/${type}`, { state: { prefill: { zone, domain, type, ...ispToScenario(isp) } } });
  };

  const act = activeRecord?.active ?? null;
  const isActiveRecord = Boolean(act && zone === act.zone && domain === act.domain && type === act.type);
  const goToActive = () => act && navigate(`/explorer/${act.zone}/${act.domain}/${act.type}`);

  return (
    <div>
      <div className="page-head">
        <h1>NS1 Explorer</h1>
        <p>Read-only discovery of NS1 zones and records. GET-only — RADAR never writes to NS1.</p>
      </div>

      {/* The active steering record can switch (live.rte.ie is re-pointed); surface it + any change. */}
      {activeChanged && (
        <div className="notice warn" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span className="badge warn">ACTIVE RECORD CHANGED</span>
          <span><b>live.rte.ie</b> now points to <span className="mono">{activeChanged.to}</span> (was <span className="mono">{activeChanged.from}</span>).</span>
          <button className="ghost" style={{ marginLeft: 'auto' }} onClick={goToActive}>View active record</button>
          <button className="ghost" onClick={() => setActiveChanged(null)}>Dismiss</button>
        </div>
      )}
      {act && (
        <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span className={`badge ${isActiveRecord ? 'ok' : 'neutral'}`}>ACTIVE STEERING RECORD</span>
          <span><b>live.rte.ie</b> → <span className="mono">{act.domain}</span>{activeRecord?.filterCount != null ? ` · ${activeRecord.filterCount}-filter chain` : ''}</span>
          {!isActiveRecord && <button className="ghost" style={{ marginLeft: 'auto' }} onClick={goToActive}>Go to active record</button>}
        </div>
      )}
      {activeRecord?.entry && !act && (
        <div className="notice warn">Active steering record could not be resolved{activeRecord.warnings?.[0] ? ` — ${activeRecord.warnings[0]}` : ''}.</div>
      )}

      <div className="card">
        <div className="step-head">
          <h3 style={{ margin: 0 }}>Zone</h3>
          {zonesError ? (
            <span className="notice danger">{zonesError}</span>
          ) : zones === null ? (
            <span className="muted">Loading zones…</span>
          ) : (
            <select aria-label="Zone" value={zone ?? ''} onChange={(e) => e.target.value && navigate(`/explorer/${e.target.value}`)}>
              <option value="">Select a zone…</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          )}
        </div>

        {recent.length > 0 && (
          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ marginRight: '0.4rem' }}>
              Recent:
            </span>
            {recent.map((r) => (
              <Link key={`${r.zone}/${r.domain}/${r.type}`} className="chip" to={`/explorer/${r.zone}/${r.domain}/${r.type}`} style={{ marginRight: '0.3rem' }}>
                {r.domain} {r.type}
              </Link>
            ))}
          </div>
        )}
      </div>

      {zone && (
        <div className="card">
          <h3>Records in {zone}</h3>
          {recordsError ? (
            <div className="notice danger">{recordsError}</div>
          ) : records === null ? (
            <span className="muted">Loading records…</span>
          ) : records.length === 0 ? (
            <div className="notice info">No records found in this zone.</div>
          ) : (
            <div className="flow">
              {records.map((r) => {
                const active = r.domain === domain && r.type === type;
                return (
                  <button key={`${r.domain}/${r.type}`} className={`ghost ${active ? 'active' : ''}`} onClick={() => selectRecord(r)}>
                    {r.domain} <span className="mono muted">{r.type}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {zone && domain && type && canExplain && (
        <div className="card">
          <IspSteeringOverview zone={zone} domain={domain} type={type} onPick={explainIsp} />
        </div>
      )}

      {zone && domain && type && (
        // Record and its explanation sit side by side; the record collapses to full width when
        // Explain is hidden, and both stack on narrow screens (flexWrap). minWidth:0 lets the
        // raw-JSON pre scroll inside its column instead of forcing the row wider.
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="card" style={{ flex: showExplain ? '1 1 340px' : '1 1 100%', minWidth: 0 }}>
            <div className="step-head">
              <h3 style={{ margin: 0 }}>
                Record: <span className="mono">{domain}</span> {type}
              </h3>
              <button className={`ghost ${view === 'config' ? 'active' : ''}`} onClick={() => { setView('config'); setEditing(false); }} title="Human-readable steering config — platforms, translated ASNs/countries, weights, filter chain">
                Config
              </button>
              {canExplain && (
                <button className={`ghost ${view === 'walkthrough' ? 'active' : ''}`} onClick={() => { setView('walkthrough'); setEditing(false); }} title="Walk the filter chain top-down for a chosen requester — see each yes/no branch and how the weighting resolves">
                  Walkthrough
                </button>
              )}
              <button className={`ghost ${view === 'normalised' ? 'active' : ''}`} onClick={() => { setView('normalised'); setEditing(false); }}>
                Normalised
              </button>
              <button
                className={`ghost ${view === 'raw' ? 'active' : ''}`}
                onClick={() => setView('raw')}
                disabled={!canRaw}
                title={canRaw ? 'Raw NS1 object' : 'Requires the ns1.raw.read permission'}
              >
                Raw NS1
              </button>
              {canRaw && view === 'raw' && payload !== null && (
                <button
                  className={`ghost ${editing ? 'active' : ''}`}
                  onClick={() => setEditing((v) => !v)}
                  title="Edit the record JSON and copy an NS1-ready payload"
                >
                  {editing ? 'Done editing' : 'Edit / Copy for NS1'}
                </button>
              )}
              {canExplain && (
                <button className={`primary ${showExplain ? 'active' : ''}`} style={{ marginLeft: 'auto' }} onClick={() => setShowExplain((v) => !v)}>
                  {showExplain ? 'Hide explanation' : 'Explain this record'}
                </button>
              )}
            </div>
            {view === 'walkthrough' ? (
              <RecordWalkthrough zone={zone} domain={domain} type={type} />
            ) : recordError ? (
              <div className="notice danger">{recordError}</div>
            ) : payload === null ? (
              <span className="muted">Loading record…</span>
            ) : (
              <>
                {isActiveRecord && (
                  <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <span className="badge ok">ACTIVE</span>
                    <span>This is the record <b>live.rte.ie</b> currently points to — it is steering live traffic.</span>
                  </div>
                )}
                <ProvenanceLine p={payload.provenance} />
                {view === 'config' ? (
                  <RecordConfigView record={payload.body} zone={zone} domain={domain} type={type} />
                ) : editing && view === 'raw' ? (
                  <RecordEditor initial={payload.body} onClose={() => setEditing(false)} />
                ) : (
                  <pre className="raw-json">{JSON.stringify(payload.body, null, 2)}</pre>
                )}
              </>
            )}
          </div>

          {canExplain && showExplain && (
            <div className="card" style={{ flex: '1.4 1 460px', minWidth: 0 }}>
              <div className="page-head" style={{ marginBottom: '0.75rem' }}>
                <h2 style={{ margin: 0 }}>Explain DNS Decision</h2>
                <p>
                  Evaluate how NS1 steers a request for <span className="mono">{domain}</span> {type}, filter by filter. Vary the
                  request scenario below.
                </p>
              </div>
              <ExplainPanel key={`${zone}/${domain}/${type}:${location.key}`} zone={zone} domain={domain} type={type} prefill={rawPrefill} autoRun={prefillMatches} />
            </div>
          )}
        </div>
      )}

      {zone && domain && type && (
        <div className="card">
          <AsnBreakdown zone={zone} domain={domain} type={type} />
        </div>
      )}

      {zone && domain && type && hasPermission('snapshot.read') && <SnapshotsPanel zone={zone} domain={domain} type={type} />}
    </div>
  );
}

// NS1 Explorer — read-only discovery and inspection across every record the API exposes.
// The selected record is URL-addressable (/explorer/:zone/:domain/:type), so Steering and
// Explain can deep-link into it. Raw JSON is gated on ns1.raw.read. GET-only throughout.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ProvenanceLine } from '../components/Provenance';
import { addRecent, getRecent, type RecordRef } from '../ns1/recent';
import { SnapshotsPanel } from '../features/Snapshots';
import { ExplainPanel, type ExplainScenario } from '../features/ExplainPanel';
import type { Provenance } from '../api/types';

type View = 'normalised' | 'raw';
interface RecordSummary {
  domain: string;
  type: string;
}

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
  const [view, setView] = useState<View>('normalised');
  const [payload, setPayload] = useState<{ provenance: Provenance; body: Record<string, unknown> } | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecordRef[]>(getRecent());

  // Zone list (once).
  useEffect(() => {
    api
      .zones()
      .then((r) => setZones(r.zones.map(zoneName)))
      .catch(() => setZonesError('Could not load zones.'));
  }, []);

  // Records within the selected zone.
  useEffect(() => {
    if (!zone) {
      setRecords(null);
      return;
    }
    let active = true;
    setRecords(null);
    setRecordsError(null);
    api
      .zone(zone)
      .then((r) => active && setRecords(extractRecords(r.zone)))
      .catch((e: unknown) => active && setRecordsError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load records.'));
    return () => {
      active = false;
    };
  }, [zone]);

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

  return (
    <div>
      <div className="page-head">
        <h1>NS1 Explorer</h1>
        <p>Read-only discovery of NS1 zones and records. GET-only — RADAR never writes to NS1.</p>
      </div>

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
              <button className={`ghost ${view === 'normalised' ? 'active' : ''}`} onClick={() => setView('normalised')}>
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
              {canExplain && (
                <button className={`primary ${showExplain ? 'active' : ''}`} style={{ marginLeft: 'auto' }} onClick={() => setShowExplain((v) => !v)}>
                  {showExplain ? 'Hide explanation' : 'Explain this record'}
                </button>
              )}
            </div>
            {recordError ? (
              <div className="notice danger">{recordError}</div>
            ) : payload === null ? (
              <span className="muted">Loading record…</span>
            ) : (
              <>
                <ProvenanceLine p={payload.provenance} />
                <pre className="raw-json">{JSON.stringify(payload.body, null, 2)}</pre>
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
              <ExplainPanel key={`${zone}/${domain}/${type}`} zone={zone} domain={domain} type={type} prefill={rawPrefill} autoRun={prefillMatches} />
            </div>
          )}
        </div>
      )}

      {zone && domain && type && hasPermission('snapshot.read') && <SnapshotsPanel zone={zone} domain={domain} type={type} />}
    </div>
  );
}

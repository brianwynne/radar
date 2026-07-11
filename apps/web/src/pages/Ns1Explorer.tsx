// NS1 Explorer — read-only zone/record inspection. Separates the RADAR-normalised record
// view from the raw NS1 object (raw preservation). The raw view requires higher privilege.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ProvenanceLine } from '../components/Provenance';
import type { Provenance } from '../api/types';

type View = 'normalised' | 'raw';

export function Ns1Explorer() {
  const { hasPermission } = useAuth();
  const canRaw = hasPermission('ns1.raw.read');
  const [zones, setZones] = useState<unknown[] | null>(null);
  const [view, setView] = useState<View>('normalised');
  const [payload, setPayload] = useState<{ provenance: Provenance; body: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Demo target from the mock fixture; a zone/record picker is a later enhancement.
  const target = { zone: 'rte.ie', domain: 'live.rte.ie', type: 'A' };

  useEffect(() => {
    api.zones().then((r) => setZones(r.zones)).catch(() => setZones([]));
  }, []);

  useEffect(() => {
    setError(null);
    const load =
      view === 'raw' && canRaw
        ? api.rawRecord(target.zone, target.domain, target.type).then((r) => ({ provenance: r.provenance, body: r.raw }))
        : api.record(target.zone, target.domain, target.type).then((r) => ({ provenance: r.provenance, body: r.record }));
    load.then(setPayload).catch((e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load record.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, canRaw]);

  return (
    <div>
      <div className="page-head">
        <h1>NS1 Explorer</h1>
        <p>Read-only inspection of NS1 zones and records. GET-only — RADAR never writes to NS1.</p>
      </div>

      <div className="card">
        <h3>Zones</h3>
        {zones === null ? (
          <span className="muted">Loading…</span>
        ) : (
          <div className="flow">
            {zones.map((z, i) => {
              const name = (z as { zone?: string }).zone ?? `zone-${i}`;
              return (
                <span key={name} className="chip">
                  {name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="step-head">
          <h3 style={{ margin: 0 }}>
            Record: <span className="mono">{target.domain}</span> {target.type}
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
        </div>
        {error && <div className="notice danger">{error}</div>}
        {payload && (
          <>
            <ProvenanceLine p={payload.provenance} />
            <pre className="raw-json">{JSON.stringify(payload.body, null, 2)}</pre>
          </>
        )}
      </div>
    </div>
  );
}

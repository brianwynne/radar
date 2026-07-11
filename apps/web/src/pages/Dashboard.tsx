// NOC dashboard — high-level monitoring overview. Telemetry (delivery health, viewer
// distribution) is intentionally shown as "not connected" in v1: RADAR does not yet
// ingest operational telemetry (see docs/ui-data-provenance.md).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export function Dashboard() {
  const { principal, hasPermission } = useAuth();
  const [zones, setZones] = useState<number | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasPermission('ns1.detail.read')) return;
    api
      .zones()
      .then((r) => setZones(r.zones.length))
      .catch(() => setZonesError('unavailable'));
  }, [hasPermission]);

  return (
    <div>
      <div className="page-head">
        <h1>Delivery Steering — NOC Overview</h1>
        <p>Welcome{principal?.displayName ? `, ${principal.displayName}` : ''}. RADAR explains NS1 steering; it never changes it (read-only v1).</p>
      </div>

      <div className="grid cols-3">
        <div className="card">
          <div className="muted">NS1 zones visible</div>
          <div className="stat">{zonesError ? '—' : (zones ?? '…')}</div>
          {hasPermission('ns1.detail.read') ? (
            <Link to="/explorer">Open NS1 Explorer →</Link>
          ) : (
            <span className="muted">Requires Viewing Engineer</span>
          )}
        </div>
        <div className="card">
          <div className="muted">Steering explainability</div>
          <div className="stat">Ready</div>
          {hasPermission('dns.explain.read') ? <Link to="/explain">Explain a DNS decision →</Link> : <span className="muted">Requires Viewing Engineer</span>}
        </div>
        <div className="card">
          <div className="muted">Write access</div>
          <div className="stat">None</div>
          <span className="muted">RADAR v1 is read-only to NS1.</span>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Delivery-platform health</h3>
          <div className="notice info">Telemetry not connected — operational health ingestion arrives in a later version.</div>
        </div>
        <div className="card">
          <h3>Observed viewer distribution</h3>
          <div className="notice info">Telemetry not connected — RADAR currently shows configured/derived data only, not measured traffic.</div>
        </div>
      </div>
    </div>
  );
}

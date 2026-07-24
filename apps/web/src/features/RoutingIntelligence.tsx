// Routing Intelligence — external BGP visibility from bgp.tools (read-only). A tab inside Network
// Telemetry: overall integrity, a prefix visibility matrix (expected vs observed origin, visibility
// %, upstreams, integrity state), and the incident feed. Every conclusion is traceable to the
// evidence in the drawer. RADAR never modifies BGP or NS1 — this is evidence + a safety signal.
import { Fragment, useMemo, useState } from 'react';
import { useRoutingIntelligence } from '../telemetry/use-routing-intelligence';
import { formatFreshness } from '../telemetry/format';
import type { RoutingAssessment, RoutingIncident, RoutingIntegrityState } from '../api/types';

const STATE_BADGE: Record<RoutingIntegrityState, string> = { healthy: 'ok', degraded: 'warn', critical: 'danger', unknown: 'neutral' };
// Matrix sort order — worst integrity first.
const SEVERITY: Record<RoutingIntegrityState, number> = { critical: 0, degraded: 1, unknown: 2, healthy: 3 };
const STATE_LABEL: Record<RoutingIntegrityState, string> = { healthy: 'Healthy', degraded: 'Degraded', critical: 'Critical', unknown: 'Unknown' };

const KIND_LABEL: Record<string, string> = {
  withdrawn: 'Withdrawn', hijack: 'Unexpected origin', moas: 'MOAS', visibility_loss: 'Visibility loss',
  missing_upstream: 'Missing upstream', new_upstream: 'New upstream',
};

const pctOf = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
const ago = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

function StateBadge({ state }: { state: RoutingIntegrityState }) {
  return <span className={`badge ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>;
}

// A compact visibility bar coloured by integrity (green ok, amber degraded, red critical).
function VisibilityBar({ ratio, state }: { ratio: number | null; state: RoutingIntegrityState }) {
  if (ratio === null) return <span className="muted">—</span>;
  return (
    <div className="ri-vis" title={`${pctOf(ratio)} visibility`}>
      <div className={`ri-vis-fill ri-vis-${STATE_BADGE[state]}`} style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} />
      <span className="ri-vis-label">{pctOf(ratio)}</span>
    </div>
  );
}

function PrefixDrawer({ a }: { a: RoutingAssessment }) {
  const s = a.signals;
  if (!s) return null;
  return (
    <tr className="ri-drawer">
      <td colSpan={8}>
        <div className="ri-drawer-body">
          <ul className="ri-reasons">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <div className="ri-evidence">
            <span><b>Observed origins:</b> {s.observedOrigins.length ? s.observedOrigins.map((o) => `AS${o.asn}`).join(', ') : '—'}</span>
            <span><b>Upstreams:</b> {s.observedUpstreams.length ? s.observedUpstreams.map((u) => `AS${u}`).join(', ') : '—'}</span>
            {s.missingUpstreams.length > 0 && <span className="danger"><b>Missing:</b> {s.missingUpstreams.map((u) => `AS${u}`).join(', ')}</span>}
            {s.newUpstreams.length > 0 && <span className="warn"><b>New:</b> {s.newUpstreams.map((u) => `AS${u}`).join(', ')}</span>}
            <span><b>Visible paths:</b> {s.visiblePaths ?? '—'}</span>
            <span><b>Confidence:</b> {s.sourceConfidence}</span>
            <span><b>First seen:</b> {ago(s.firstObservedAt)}</span>
          </div>
        </div>
      </td>
    </tr>
  );
}

function IncidentRow({ i }: { i: RoutingIncident }) {
  const dur = i.resolvedAt ? Math.max(0, (Date.parse(i.resolvedAt) - Date.parse(i.firstDetectedAt)) / 1000) : (Date.now() - Date.parse(i.firstDetectedAt)) / 1000;
  return (
    <tr className={i.state === 'resolved' ? 'muted' : undefined}>
      <td><span className={`badge ${i.severity === 'critical' ? 'danger' : 'warn'} badge-sm`}>{i.severity}</span></td>
      <td>{KIND_LABEL[i.kind] ?? i.kind}</td>
      <td>{i.prefix}</td>
      <td><span className="badge neutral badge-sm">{i.state}</span></td>
      <td className="muted">{ago(i.firstDetectedAt)}</td>
      <td className="muted">{formatFreshness(dur)}</td>
      <td>{i.observationCount}</td>
    </tr>
  );
}

export function RoutingIntelligence() {
  const t = useRoutingIntelligence(15000);
  const [openPrefix, setOpenPrefix] = useState<string | null>(null);
  const status = t.status;
  const snap = t.snapshot;
  const conn = t.connection;

  const source = status?.source ?? 'disabled';
  const modeBadge = source === 'bgptools' ? { cls: 'ok', label: 'LIVE · bgp.tools' } : source === 'mock' ? { cls: 'warn', label: 'MOCK · SYNTHETIC' } : { cls: 'neutral', label: 'NOT CONNECTED' };

  // Sort the matrix worst-first so problems surface at the top.
  const rows = useMemo(
    () => [...(snap?.assessments ?? [])].sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state] || (a.prefix ?? '').localeCompare(b.prefix ?? '')),
    [snap],
  );
  const openIncidents = useMemo(() => t.incidents.filter((i) => i.state !== 'resolved'), [t.incidents]);
  const counts = snap?.counts ?? status?.counts ?? { healthy: 0, degraded: 0, critical: 0, unknown: 0, total: 0 };

  return (
    <section className="ri">
      <div className="section-head">
        <h2>Routing Intelligence <span className="muted">· bgp.tools</span></h2>
        <span className={`badge ${modeBadge.cls}`}>{modeBadge.label}</span>
        {status?.lastSuccessAt && <span className="muted">updated {ago(status.lastSuccessAt)}</span>}
      </div>

      {t.error && <div className="notice info">{/^.*(not configured|disabled|503).*/i.test(t.error) ? 'bgp.tools routing intelligence is not connected. An Engineer can enable it in Integrations.' : t.error}</div>}
      {!t.error && !status?.enabled && <div className="notice info">The bgp.tools connector is disabled. Enable it in Integrations to see external routing intelligence.</div>}
      {conn && conn.enabled && conn.mode === 'live' && !conn.hasDataSource && (
        <div className="notice danger">
          Live mode is on but no data source is active — {conn.degraded ?? (!conn.prometheusUrlConfigured ? 'no Prometheus URL is configured' : !conn.userAgentValid ? 'the User-Agent (with a contact email) is not set' : 'the connector could not build a client')}.{' '}
          Fix it in <b>Integrations → bgp.tools</b> (set the User-Agent and Prometheus URL, then Save) — the watch list is then auto-discovered from your feed.
        </div>
      )}
      {status?.lastError && <div className="notice warn">Last poll error: {status.lastError}</div>}
      {snap?.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}

      {/* Overview */}
      <div className="grid cols-4">
        <div className="card">
          <div className="muted">External routing integrity</div>
          <div className="stat"><StateBadge state={snap?.overall ?? status?.overall ?? 'unknown'} /></div>
        </div>
        <div className="card">
          <div className="muted">Monitored prefixes</div>
          <div className="stat">{counts.total}</div>
          <div className="ri-counts">
            <span className="badge ok badge-sm">{counts.healthy} healthy</span>
            {counts.degraded > 0 && <span className="badge warn badge-sm">{counts.degraded} degraded</span>}
            {counts.critical > 0 && <span className="badge danger badge-sm">{counts.critical} critical</span>}
            {counts.unknown > 0 && <span className="badge neutral badge-sm">{counts.unknown} unknown</span>}
          </div>
        </div>
        <div className="card">
          <div className="muted">Active incidents</div>
          <div className="stat">{openIncidents.length}</div>
        </div>
        <div className="card">
          <div className="muted">Connector</div>
          <div className="stat">{status?.running ? 'running' : 'stopped'}</div>
          <div className="muted">{status?.snapshotAgeSeconds != null ? `data ${formatFreshness(status.snapshotAgeSeconds)}` : 'no data yet'}</div>
        </div>
      </div>

      {/* ASN topology (from the monitoring feed) */}
      {snap?.asns && snap.asns.length > 0 && (
        <>
          <h3>ASN topology</h3>
          <div className="matrix-wrap">
            <table className="matrix">
              <thead><tr><th>ASN</th><th>Peers</th><th>Upstreams</th><th>Downstreams</th><th>Cone</th><th>Prefixes visible</th><th>incl. low-vis</th></tr></thead>
              <tbody>
                {snap.asns.map((a) => (
                  <tr key={a.asn}>
                    <td><b>AS{a.asn}</b></td>
                    <td>{a.peers ?? '—'}</td>
                    <td>{a.upstreams ?? '—'}</td>
                    <td>{a.downstreams ?? '—'}</td>
                    <td>{a.cone ?? '—'}</td>
                    <td>{a.prefixesTotal ?? '—'}</td>
                    <td className={a.prefixesLowVis != null && a.prefixesTotal != null && a.prefixesLowVis > a.prefixesTotal ? 'warn' : 'muted'}>{a.prefixesLowVis ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Prefix visibility matrix */}
      <h3>Prefix visibility</h3>
      <div className="matrix-wrap">
        <table className="matrix selectable">
          <thead>
            <tr><th>Prefix</th><th>AF</th><th>Expected</th><th>Observed</th><th>Visibility</th><th>Upstreams</th><th>Integrity</th><th></th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="center-note">{t.loading ? 'Loading…' : 'No monitored prefixes.'}</td></tr>}
            {rows.map((a) => {
              const s = a.signals;
              const open = openPrefix === a.prefix;
              return (
                <Fragment key={a.prefix}>
                  <tr className={s ? 'row-click' : undefined} onClick={() => s && setOpenPrefix(open ? null : a.prefix ?? null)}>
                    <td>{a.prefix}</td>
                    <td className="muted">{s?.addressFamily === 'ipv6' ? 'v6' : 'v4'}</td>
                    <td>AS{s?.expectedOriginAsn ?? '—'}</td>
                    <td className={s && !s.originAsExpected ? 'danger' : undefined}>{s?.prefixWithdrawn ? '—' : s?.observedOriginAsn != null ? `AS${s.observedOriginAsn}` : '—'}{s?.moas ? ' +MOAS' : ''}</td>
                    <td>{s?.prefixWithdrawn ? <span className="badge danger badge-sm">withdrawn</span> : <VisibilityBar ratio={s?.prefixVisibilityRatio ?? null} state={a.state} />}</td>
                    <td>{s?.upstreamCount ?? '—'}{s && s.missingUpstreams.length > 0 ? <span className="danger"> −{s.missingUpstreams.length}</span> : ''}{s && s.newUpstreams.length > 0 ? <span className="warn"> +{s.newUpstreams.length}</span> : ''}</td>
                    <td><StateBadge state={a.state} /></td>
                    <td className="muted">{s ? (open ? '▾' : '▸') : ''}</td>
                  </tr>
                  {open && <PrefixDrawer a={a} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Incident feed */}
      <h3>Incidents {t.incidents.length > 0 && <span className="muted">({openIncidents.length} active)</span>}</h3>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead><tr><th>Severity</th><th>Type</th><th>Prefix</th><th>State</th><th>Detected</th><th>Duration</th><th>Obs</th></tr></thead>
          <tbody>
            {t.incidents.length === 0 && <tr><td colSpan={7} className="center-note">No incidents.</td></tr>}
            {t.incidents.map((i) => <IncidentRow key={i.id} i={i} />)}
          </tbody>
        </table>
      </div>

      <p className="muted ri-foot">Read-only external routing observation from bgp.tools. RADAR never modifies BGP or NS1; these signals are evidence and a routing-integrity safety indicator only.</p>
    </section>
  );
}

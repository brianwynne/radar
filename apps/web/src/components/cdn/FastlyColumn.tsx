// Fastly column of the Commercial CDN page. Read-only, informational. Its own service filter drives
// a per-second live-tail (bandwidth + requests/s sparklines) and the realtime status-code panel for
// the selected service, above a compact per-service table. A missing/absent value is shown as such.
import { useEffect, useMemo, useState } from 'react';
import { useFastly } from '../../telemetry/use-fastly';
import { useFastlyRealtime } from '../../telemetry/use-fastly-realtime';
import { Sparkline } from '../../telemetry/Sparkline';
import { StatusCodePanel, type StatusCodePoint } from './StatusCodePanel';
import { formatBps, formatPercent } from '../../telemetry/format';

const rps = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${n.toLocaleString()}/s`);
const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString());

export function FastlyColumn() {
  const t = useFastly(30_000);
  const rt = useFastlyRealtime(2000);
  const [selected, setSelected] = useState<string>('');

  // Services sorted by current throughput; default the selection to the busiest one.
  const services = useMemo(() => [...t.services].sort((a, b) => b.requestsPerSecond - a.requestsPerSecond), [t.services]);
  useEffect(() => {
    if (!selected && services.length > 0) setSelected(services[0].serviceId);
  }, [selected, services]);

  const mode = t.provenance?.source ?? null;
  const modeBadge = mode === 'fastly' ? 'ok' : mode === 'mock' ? 'warn' : 'neutral';
  const modeLabel = mode === 'fastly' ? 'LIVE' : mode === 'mock' ? 'MOCK' : 'NOT CONNECTED';

  const series = rt.series.find((s) => s.serviceId === selected) ?? null;
  const samples = series?.samples ?? [];
  const points: StatusCodePoint[] = samples.map((s) => ({ status2xx: s.status2xx, status3xx: s.status3xx, status4xx: s.status4xx, status5xx: s.status5xx, codes: s.statusCodes }));
  const rtLive = rt.source === 'fastly';

  return (
    <section className="cdn-col card">
      <header className="cdn-col-head">
        <div>
          <h2 style={{ margin: 0 }}>Fastly</h2>
          <div className="muted" style={{ fontSize: '0.72rem' }}>commercial CDN · delivery platform NS1 can steer to</div>
        </div>
        <span className={`badge ${modeBadge}`}>{modeLabel}</span>
      </header>

      {mode === 'disabled' && <div className="notice info">Fastly connector is disabled — set a read-only <code>global:read</code> token to see live telemetry.</div>}
      {t.error && <div className="notice danger">{t.error}</div>}

      {/* Whole-CDN summary */}
      <div className="grid cols-4" style={{ gap: '0.4rem' }}>
        <div className="card"><div className="muted">Services</div><div className="stat">{num(t.summary?.serviceCount)}</div></div>
        <div className="card"><div className="muted">Requests</div><div className="stat">{rps(t.summary?.totalRequestsPerSecond)}</div></div>
        <div className="card"><div className="muted">Bandwidth</div><div className="stat">{formatBps(t.summary?.totalBandwidthBps)}</div></div>
        <div className="card"><div className="muted">Hit ratio</div><div className="stat">{formatPercent(t.summary?.avgHitRatioPercent)}</div></div>
      </div>

      {/* Per-CDN service filter */}
      <label className="field" style={{ marginTop: '0.6rem' }}>
        <span>Service</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {services.length === 0 && <option value="">No services</option>}
          {services.map((s) => <option key={s.serviceId} value={s.serviceId}>{s.serviceName}</option>)}
        </select>
      </label>

      {/* Selected-service live-tail + realtime status codes */}
      {series && (
        <div className="cdn-selected">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
            <div>
              <strong>{series.serviceName}</strong>
              <div className="muted" style={{ fontSize: '0.72rem' }}>{series.serviceId}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="stat" style={{ lineHeight: 1.1 }}>{formatBps(series.latestBandwidthBps)}</div>
              <div className="muted">{rps(series.latestRequestsPerSecond)}</div>
            </div>
          </div>
          {samples.length === 0 ? (
            <div className="center-note" style={{ padding: '0.6rem 0' }}>{rtLive ? `idle — no traffic in the last ${rt.windowSeconds}s` : 'live-tail is live-only'}</div>
          ) : (
            <>
              <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>Bandwidth</div>
              <Sparkline data={samples.map((s) => s.bandwidthBytes * 8)} width={320} height={38} ariaLabel={`${series.serviceName} bandwidth`} />
              <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.3rem' }}>Requests/s</div>
              <Sparkline data={samples.map((s) => s.requests)} width={320} height={38} ariaLabel={`${series.serviceName} requests per second`} color="var(--accent, currentColor)" />
              <div style={{ marginTop: '0.5rem' }}>
                <StatusCodePanel points={points} cadenceLabel={`per-second · ${rt.windowSeconds}s`} live={rtLive} />
              </div>
            </>
          )}
        </div>
      )}

      {/* Compact per-service table (latest finalised minute; Fastly stats lag ~3 min) */}
      <div className="matrix-wrap" style={{ marginTop: '0.6rem' }}>
        <table className="matrix">
          <thead><tr><th>Service</th><th>Req/s</th><th>Hit</th><th>Bandwidth</th><th>5xx</th></tr></thead>
          <tbody>
            {services.length === 0 && <tr><td colSpan={5} className="center-note">No services.</td></tr>}
            {services.map((s) => (
              <tr key={s.serviceId} className={`row-click ${s.serviceId === selected ? 'row-selected' : ''}`} onClick={() => setSelected(s.serviceId)}>
                <td>{s.serviceName}</td>
                <td>{s.requestsPerSecond.toLocaleString()}</td>
                <td>{formatPercent(s.hitRatioPercent)}</td>
                <td>{formatBps(s.bandwidthBps)}</td>
                <td className="muted">{num(s.status5xx)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

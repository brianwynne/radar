// Fastly CDN — read-only commercial-CDN delivery observability: per-service requests, cache hit
// ratio, bandwidth, origin offload and status-code mix. Informational only — RADAR issues no
// Fastly writes. A missing/absent value is shown as such, never invented. Auto-refreshes.
import { useEffect, useMemo, useState } from 'react';
import { useFastly } from '../telemetry/use-fastly';
import { useFastlyRealtime } from '../telemetry/use-fastly-realtime';
import { Sparkline } from '../telemetry/Sparkline';
import { formatBps, formatFreshness, formatPercent } from '../telemetry/format';

const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString());
const rps = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${n.toLocaleString()}/s`);

/** Cell class for the hit-ratio column (lower is worse). */
const hitClass = (pct: number | null): string => (pct === null ? '' : pct < 50 ? 'util-crit' : pct < 80 ? 'util-warn' : '');
/** Cell class for the error-rate column (higher is worse). */
const errClass = (pct: number | null): string => (pct === null ? '' : pct > 5 ? 'util-crit' : pct > 1 ? 'util-warn' : '');

export function FastlyCdn() {
  const t = useFastly(30_000);
  const rt = useFastlyRealtime(2000);
  const [search, setSearch] = useState('');

  const q = search.trim().toLowerCase();
  const services = useMemo(
    () => t.services.filter((s) => !q || `${s.serviceName} ${s.serviceId}`.toLowerCase().includes(q)),
    [t.services, q],
  );

  // Per-second countdown to the next live read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsToRefresh = t.refreshMs && t.lastLoadedAt !== null ? Math.max(0, Math.ceil((t.lastLoadedAt + t.refreshMs - now) / 1000)) : null;

  const mode = t.provenance?.source ?? null;
  const modeBadge = mode === 'fastly' ? 'ok' : mode === 'mock' ? 'warn' : 'neutral';
  const modeLabel = mode === 'fastly' ? 'LIVE · Fastly' : mode === 'mock' ? 'MOCK · SYNTHETIC' : 'NOT CONNECTED';

  return (
    <section className="page">
      <header className="page-head">
        <h1>Fastly CDN</h1>
        <div className="head-meta">
          <span className={`badge ${modeBadge}`}>{modeLabel}</span>
          {secondsToRefresh !== null && (
            <span className="badge live-countdown" title="Countdown to the next live read from Fastly">
              <span className="live-dot" />
              {secondsToRefresh === 0 ? 'reading…' : `next read in ${secondsToRefresh}s`}
            </span>
          )}
          {t.status?.snapshotAgeSeconds !== undefined && t.status?.snapshotAgeSeconds !== null && (
            <span className="muted">updated {formatFreshness(t.status.snapshotAgeSeconds)}</span>
          )}
        </div>
      </header>

      {t.provenance && <div className="notice info">Commercial CDN delivery telemetry — a <strong>delivery platform NS1 can steer to</strong>, alongside the Réalta caches. {t.provenance.notice}</div>}
      {mode === 'disabled' && <div className="notice info">Fastly connector is disabled — set a read-only Fastly API token (<code>global:read</code>) to see live delivery telemetry.</div>}
      {t.error && <div className="notice danger">{t.error}</div>}
      {t.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}

      {/* Summary */}
      <div className="grid cols-4">
        <div className="card"><div className="muted">Services</div><div className="stat">{num(t.summary?.serviceCount)}</div></div>
        <div className="card"><div className="muted">Requests</div><div className="stat">{rps(t.summary?.totalRequestsPerSecond)}</div></div>
        <div className="card"><div className="muted">Bandwidth</div><div className="stat">{formatBps(t.summary?.totalBandwidthBps)}</div></div>
        <div className="card"><div className="muted">Avg hit ratio</div><div className="stat">{formatPercent(t.summary?.avgHitRatioPercent)}</div></div>
      </div>

      {/* Real-time live-tail — per-second stream from Fastly real-time analytics (live-only). */}
      <h2>
        Live tail{' '}
        {rt.source === 'fastly'
          ? <span className="badge live-countdown"><span className="live-dot" />per-second · {rt.windowSeconds}s window</span>
          : <span className="muted">(live-only — the per-second stream needs a live Fastly connection)</span>}
      </h2>
      {rt.error && <div className="notice warn">{rt.error}</div>}
      {rt.source === 'fastly' && (
        <div className="grid cols-2">
          {rt.series.length === 0 && <div className="card center-note">No services streaming.</div>}
          {rt.series.map((s) => {
            const reqs = s.samples.map((x) => x.requests);
            const bps = s.samples.map((x) => x.bandwidthBytes * 8);
            const lastSecond = s.samples[s.samples.length - 1];
            const idle = s.samples.length === 0;
            return (
              <div key={s.serviceId} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div>
                    <strong>{s.serviceName}</strong>
                    <div className="muted" style={{ fontSize: '0.72rem' }}>{s.serviceId}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="stat" style={{ lineHeight: 1.1 }}>{formatBps(s.latestBandwidthBps)}</div>
                    <div className="muted">{rps(s.latestRequestsPerSecond)}</div>
                  </div>
                </div>
                {idle ? (
                  <div className="center-note" style={{ padding: '0.75rem 0' }}>idle — no traffic in the last {rt.windowSeconds}s</div>
                ) : (
                  <>
                    <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>Requests/s</div>
                    <Sparkline data={reqs} width={320} height={40} ariaLabel={`${s.serviceName} requests per second`} color="var(--accent, currentColor)" />
                    <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.3rem' }}>Bandwidth</div>
                    <Sparkline data={bps} width={320} height={40} ariaLabel={`${s.serviceName} bandwidth`} />
                    {lastSecond && (
                      <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>
                        last second — hits {num(lastSecond.hits)} · miss {num(lastSecond.miss)} · 4xx {num(lastSecond.status4xx)} · 5xx {num(lastSecond.status5xx)} · {s.samples.length}/{rt.windowSeconds} buffered
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="filters">
        <label className="field"><span>Search</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="service name / id" /></label>
      </div>

      {/* Per-service delivery telemetry */}
      <h2>Services <span className="muted">(latest finalised minute · Fastly stats lag ~3 min)</span></h2>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Service</th><th>Requests/s</th><th>Hit ratio</th><th>Bandwidth</th><th>Origin offload</th><th>Error rate</th><th>2xx</th><th>4xx</th><th>5xx</th>
            </tr>
          </thead>
          <tbody>
            {services.length === 0 && <tr><td colSpan={9} className="center-note">No services.</td></tr>}
            {services.map((s) => (
              <tr key={s.serviceId}>
                <td>{s.serviceName}<div className="muted" style={{ fontSize: '0.72rem' }}>{s.serviceId}</div></td>
                <td>{s.requestsPerSecond.toLocaleString()}</td>
                <td className={hitClass(s.hitRatioPercent)}>{formatPercent(s.hitRatioPercent)}</td>
                <td>{formatBps(s.bandwidthBps)}</td>
                <td>{formatPercent(s.originOffloadPercent)}</td>
                <td className={errClass(s.errorRatePercent)}>{formatPercent(s.errorRatePercent)}</td>
                <td className="muted">{num(s.status2xx)}</td>
                <td className="muted">{num(s.status4xx)}</td>
                <td className="muted">{num(s.status5xx)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

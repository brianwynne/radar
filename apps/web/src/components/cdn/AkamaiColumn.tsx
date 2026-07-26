// Akamai column of the Commercial CDN page. Read-only, informational. Telemetry is aggregated by
// RADAR from Akamai DataStream 2 edge logs (delivered via S3), so the cadence is near-real-time
// (~1 min) rather than Fastly's per-second — labelled as such. Its own CP-code filter drives the
// live-tail (bandwidth + requests/s) and the response-code panel (with drill-down) for the selected
// service. When no telemetry is flowing yet, the column states that honestly.
import { useEffect, useMemo, useState } from 'react';
import { useAkamai } from '../../telemetry/use-akamai';
import { Sparkline } from '../../telemetry/Sparkline';
import { StatusCodePanel, type StatusCodePoint } from './StatusCodePanel';
import { formatBps } from '../../telemetry/format';

const rps = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${n.toLocaleString()}/s`);

export function AkamaiColumn() {
  const t = useAkamai(5000);
  const [selected, setSelected] = useState<string>('');

  const services = useMemo(
    () => [...t.series].sort((a, b) => (b.requestsPerSecond ?? 0) - (a.requestsPerSecond ?? 0)),
    [t.series],
  );
  useEffect(() => {
    if (!selected && services.length > 0) setSelected(services[0].serviceId);
  }, [selected, services]);

  const live = t.source === 'akamai';
  const series = t.series.find((s) => s.serviceId === selected) ?? null;
  const samples = series?.samples ?? [];
  // Plot and summarise only SETTLED seconds. DS2 arrives batched (~1 min), so the newest buckets are
  // still filling and under-report; showing them would put a misleading dip at the right edge of the
  // graph and drag the headline down. The reported throughput (series.bandwidthBps) is the settled-
  // window average computed server-side; the graph is the matching per-second settled series.
  const settledSamples = samples.filter((s) => s.settled);
  const points: StatusCodePoint[] = settledSamples.map((s) => ({ status2xx: s.status2xx, status3xx: s.status3xx, status4xx: s.status4xx, status5xx: s.status5xx, codes: s.statusCodes }));
  const settledAsOf = series?.settledAt ? new Date(series.settledAt).toLocaleTimeString() : null;

  return (
    <section className="cdn-col card">
      <header className="cdn-col-head">
        <div>
          <h2 style={{ margin: 0 }}>Akamai</h2>
          <div className="muted" style={{ fontSize: '0.72rem' }}>commercial CDN · DataStream 2 edge logs</div>
        </div>
        <span className={`badge ${live ? 'ok' : 'neutral'}`}>{live ? 'LIVE · DataStream 2' : 'NOT CONNECTED'}</span>
      </header>

      {!live && (
        <div className="notice info">
          Not connected. Akamai telemetry streams via <strong>DataStream 2 → S3</strong>, aggregated by
          RADAR. Configure the stream and RADAR&rsquo;s S3 credentials on the <strong>Integrations</strong>
          page; per-service traffic and response codes appear here once real edge logs are flowing.
        </div>
      )}
      {t.error && <div className="notice warn">{t.error}</div>}

      {live && (
        <>
          <label className="field">
            <span>Service (CP code)</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {services.length === 0 && <option value="">No services</option>}
              {services.map((s) => <option key={s.serviceId} value={s.serviceId}>{s.serviceName} ({s.serviceId})</option>)}
            </select>
          </label>

          {series && (
            <div className="cdn-selected">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                <div>
                  <strong>{series.serviceName}</strong>
                  <div className="muted" style={{ fontSize: '0.72rem' }}>CP {series.serviceId}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat" style={{ lineHeight: 1.1 }}>{formatBps(series.bandwidthBps)}</div>
                  <div className="muted">{rps(series.requestsPerSecond)}</div>
                  <div className="muted" style={{ fontSize: '0.66rem' }}>settled avg{settledAsOf ? ` · as of ${settledAsOf}` : ''}</div>
                </div>
              </div>
              {samples.length === 0 ? (
                <div className="center-note" style={{ padding: '0.6rem 0' }}>no records in the last {t.windowSeconds}s</div>
              ) : settledSamples.length === 0 ? (
                <div className="center-note" style={{ padding: '0.6rem 0' }}>collecting… (waiting for DataStream 2 buckets to settle)</div>
              ) : (
                <>
                  <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>Bandwidth (settled per-second)</div>
                  <Sparkline data={settledSamples.map((s) => s.bandwidthBytes * 8)} width={320} height={38} ariaLabel={`${series.serviceName} bandwidth`} />
                  <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.3rem' }}>Requests/s</div>
                  <Sparkline data={settledSamples.map((s) => s.requests)} width={320} height={38} ariaLabel={`${series.serviceName} requests per second`} color="var(--accent, currentColor)" />
                  <div style={{ marginTop: '0.5rem' }}>
                    <StatusCodePanel points={points} cadenceLabel={`per-second · DataStream 2 (settled, ~1 min latency)`} live={live} />
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

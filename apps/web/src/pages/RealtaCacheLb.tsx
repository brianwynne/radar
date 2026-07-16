// Réalta Cache Load Balancing — read-only Cloudflare Load Balancing view: the origin-pool
// selection downstream of NS1 (NS1 selects the delivery platform; Cloudflare then selects the
// Réalta cache pool). Informational only — RADAR issues no Cloudflare writes. A missing/absent
// value is shown as such, never invented. Auto-refreshes.
import { useEffect, useMemo, useState } from 'react';
import { useCloudflare } from '../telemetry/use-cloudflare';
import { formatFreshness } from '../telemetry/format';

const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : String(n));

/** Health badge from a tri-state (healthy | unhealthy | unknown). */
function health(ok: boolean | null): { badge: string; label: string } {
  if (ok === true) return { badge: 'ok', label: 'healthy' };
  if (ok === false) return { badge: 'danger', label: 'unhealthy' };
  return { badge: 'neutral', label: 'unknown' };
}

export function RealtaCacheLb() {
  const t = useCloudflare(30_000);
  const [search, setSearch] = useState('');

  const q = search.trim().toLowerCase();
  const loadBalancers = useMemo(
    () => t.loadBalancers.filter((lb) => !q || `${lb.name} ${lb.zoneName ?? ''} ${lb.steeringPolicy} ${lb.defaultPools.map((p) => p.poolName ?? '').join(' ')}`.toLowerCase().includes(q)),
    [t.loadBalancers, q],
  );
  const pools = useMemo(
    () => t.pools.filter((p) => !q || `${p.name} ${p.origins.map((o) => `${o.name} ${o.address}`).join(' ')}`.toLowerCase().includes(q)),
    [t.pools, q],
  );

  // Per-second countdown to the next live read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsToRefresh = t.refreshMs && t.lastLoadedAt !== null ? Math.max(0, Math.ceil((t.lastLoadedAt + t.refreshMs - now) / 1000)) : null;

  const mode = t.provenance?.source ?? null;
  const modeBadge = mode === 'cloudflare' ? 'ok' : mode === 'mock' ? 'warn' : 'neutral';
  const modeLabel = mode === 'cloudflare' ? 'LIVE · Cloudflare' : mode === 'mock' ? 'MOCK · SYNTHETIC' : 'NOT CONNECTED';

  return (
    <section className="page">
      <header className="page-head">
        <h1>Réalta Cache Load Balancing</h1>
        <div className="head-meta">
          <span className={`badge ${modeBadge}`}>{modeLabel}</span>
          {secondsToRefresh !== null && (
            <span className="badge live-countdown" title="Countdown to the next live read from Cloudflare">
              <span className="live-dot" />
              {secondsToRefresh === 0 ? 'reading…' : `next read in ${secondsToRefresh}s`}
            </span>
          )}
          {t.status?.snapshotAgeSeconds !== undefined && t.status?.snapshotAgeSeconds !== null && (
            <span className="muted">updated {formatFreshness(t.status.snapshotAgeSeconds)}</span>
          )}
        </div>
      </header>

      {t.provenance && <div className="notice info">Origin-pool selection <strong>downstream of NS1</strong>: Cloudflare Load Balancing steers traffic across the Réalta cache pools. {t.provenance.notice}</div>}
      {mode === 'disabled' && <div className="notice info">Cloudflare connector is disabled — enable it to see live load balancing and steering.</div>}
      {t.error && <div className="notice danger">{t.error}</div>}
      {t.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}

      {/* Summary */}
      <div className="grid cols-4">
        <div className="card"><div className="muted">Load balancers</div><div className="stat">{num(t.summary?.loadBalancerCount)}</div></div>
        <div className="card"><div className="muted">Origin pools</div><div className="stat">{num(t.summary?.poolCount)}</div></div>
        <div className="card"><div className="muted">Origins (caches)</div><div className="stat">{num(t.summary?.originCount)}</div></div>
        <div className="card"><div className="muted">Unhealthy pools</div><div className="stat">{num(t.summary?.unhealthyPools)}</div></div>
        <div className="card"><div className="muted">Unhealthy origins</div><div className="stat">{num(t.summary?.unhealthyOrigins)}</div></div>
      </div>

      <div className="filters">
        <label className="field"><span>Search</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="hostname / pool / origin" /></label>
      </div>

      {/* Load balancers — configured steering vs observed traffic */}
      <h2>Load balancers · steering <span className="muted">(configured weight · observed share, last 1h)</span></h2>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr><th>Hostname</th><th>Policy · location</th><th>Steers across (pool · weight · observed)</th><th>Fallback</th><th>Observed 1h</th><th>State</th></tr>
          </thead>
          <tbody>
            {loadBalancers.length === 0 && <tr><td colSpan={6} className="center-note">No load balancers.</td></tr>}
            {loadBalancers.map((lb) => {
              const obsBy = new Map((lb.observed?.byPool ?? []).map((b) => [b.key, b.sharePercent]));
              const obsTitle = lb.observed
                ? `by region: ${lb.observed.byRegion.map((b) => `${b.key} ${b.sharePercent}%`).join(', ')}\nby PoP: ${lb.observed.byColo.map((b) => `${b.key} ${b.sharePercent}%`).join(', ')}`
                : undefined;
              return (
                <tr key={lb.id}>
                  <td>{lb.name}<div className="muted" style={{ fontSize: '0.72rem' }}>{lb.zoneName ?? ''}</div></td>
                  <td><span className="chip">{lb.steeringPolicy}</span>{lb.locationStrategy && <span className="muted"> · {lb.locationStrategy}</span>}</td>
                  <td>
                    {lb.defaultPools.length === 0 ? '—' : lb.defaultPools.map((p) => {
                      const share = p.poolName ? obsBy.get(p.poolName) : undefined;
                      const bits = [p.weight !== null ? `w${p.weight}` : null, share !== undefined ? `${share}%` : null].filter(Boolean).join(' · ');
                      return <span key={p.poolId} className="chip selected" title={p.poolName ? undefined : p.poolId}>{p.poolName ?? p.poolId.slice(0, 8)}{bits && <span className="muted"> · {bits}</span>}</span>;
                    })}
                    {Object.keys(lb.regionPools).length > 0 && <span className="muted"> · +region overrides</span>}
                  </td>
                  <td className="muted">{lb.fallbackPool?.poolName ?? lb.fallbackPool?.poolId.slice(0, 8) ?? '—'}</td>
                  <td className="muted" title={obsTitle}>{lb.observed ? `${lb.observed.totalRequests.toLocaleString()} reqs` : '—'}</td>
                  <td>
                    <span className={`badge ${lb.enabled ? 'ok' : 'neutral'} badge-sm`}>{lb.enabled ? 'enabled' : 'disabled'}</span>
                    {lb.proxied && <span className="badge info badge-sm" title="Proxied through Cloudflare"> proxied</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Origin pools + their origins (caches) */}
      <h2>Origin pools · caches</h2>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr><th>Pool / origin</th><th>Address</th><th>Weight</th><th>Health</th></tr>
          </thead>
          <tbody>
            {pools.length === 0 && <tr><td colSpan={4} className="center-note">No pools.</td></tr>}
            {pools.map((p) => {
              const ph = health(p.healthy);
              return [
                <tr key={p.id} className="lag-parent">
                  <td>{p.name} <span className="muted">· {p.healthyOrigins}/{p.totalOrigins} origins healthy</span>
                    {p.healthCheck && <div className="muted" style={{ fontSize: '0.72rem' }}>check: {p.healthCheck.method ?? p.healthCheck.type} {p.healthCheck.path ?? ''} → {p.healthCheck.expectedCodes ?? ''}{p.healthCheck.expectedBody ? ` "${p.healthCheck.expectedBody}"` : ''} · every {p.healthCheck.intervalSeconds}s</div>}
                  </td>
                  <td className="muted">{p.description ?? '—'}</td>
                  <td>{!p.enabled && <span className="badge neutral badge-sm">disabled</span>}</td>
                  <td><span className={`badge ${ph.badge}`}>{ph.label}</span></td>
                </tr>,
                ...p.origins.map((o) => {
                  const oh = health(o.healthy);
                  return (
                    <tr key={`${p.id}::${o.name}`} className="lag-member">
                      <td className="itf-member"><span className="tree-branch">└─ </span>{o.name}</td>
                      <td className="muted">{o.address}</td>
                      <td>{o.weight}</td>
                      <td><span className={`badge ${oh.badge} badge-sm`}>{oh.label}</span>{o.failureReason && <span className="muted" title={o.failureReason}> ⓘ</span>}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

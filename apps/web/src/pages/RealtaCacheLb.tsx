// Réalta Cache Load Balancing — read-only Cloudflare Load Balancing view: the origin-pool
// selection downstream of NS1 (NS1 selects the delivery platform; Cloudflare then selects the
// Réalta cache pool). Informational only — RADAR issues no Cloudflare writes. A missing/absent
// value is shown as such, never invented. Auto-refreshes.
import { useEffect, useMemo, useState } from 'react';
import { useCloudflare } from '../telemetry/use-cloudflare';
import { useCloudflareFocused } from '../telemetry/use-cloudflare-focused';
import { formatFreshness } from '../telemetry/format';
import type { CloudflareOrigin, CloudflarePool } from '../api/types';

/** Client-side caps that keep the fast tier bounded (the server enforces its own hard cap too). */
const MAX_FOCUS_POOLS = 8; // pools live-refreshed on the fast tier (extras still pin, just refresh at the slow rate)

const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : String(n));

/** Health badge from a tri-state (healthy | unhealthy | unknown). */
function health(ok: boolean | null): { badge: string; label: string } {
  if (ok === true) return { badge: 'ok', label: 'healthy' };
  if (ok === false) return { badge: 'danger', label: 'unhealthy' };
  return { badge: 'neutral', label: 'unknown' };
}

/** Pool config summary line: origin steering, load shedding, check regions, monitor interval. */
function poolDetail(p: CloudflarePool): string {
  const bits: string[] = [];
  if (p.originSteeringPolicy) bits.push(`origins: ${p.originSteeringPolicy}`);
  if (p.loadShedding && (p.loadShedding.defaultPercent ?? 0) > 0) bits.push(`shedding ${p.loadShedding.defaultPercent}%`);
  if (p.checkRegions.length) bits.push(`checks: ${p.checkRegions.join(',')}`);
  if (p.healthCheck?.intervalSeconds) bits.push(`every ${p.healthCheck.intervalSeconds}s`);
  return bits.join(' · ') || '—';
}

/** Tooltip for an origin: Host header + per-region health & RTT. */
function rttTitle(o: CloudflareOrigin): string {
  const head = o.hostHeader ? `Host: ${o.hostHeader}` : '';
  if (o.regionHealth.length === 0) return head;
  const rh = o.regionHealth.map((r) => `${r.region}: ${r.healthy === false ? 'down' : 'up'}${r.rttMs !== null ? ` ${r.rttMs}ms` : ''}${r.healthy === false && r.failureReason ? ` (${r.failureReason})` : ''}`).join('\n');
  return head ? `${head}\n${rh}` : rh;
}

const PINNED_KEY = 'radar.cacheLb.pinnedLoadBalancers';
const POOLS_PINNED_KEY = 'radar.cacheLb.pinnedPools';
// One-time default focused view (matched by name, case-insensitive) — the primary live/VOD delivery
// load balancers and their key origin pools, so the page is useful on first open. Seeded once (see
// SEEDED_KEY); never overrides a later manual change.
const SEEDED_KEY = 'radar.cacheLb.defaultsSeeded.v1';
const DEFAULT_PINNED_LBS = new Set(['live.rte.host', 'liveaudio-edge.rte.ie', 'liveedge.rte.ie', 'vod-edge.rte.ie', 'vod-origin.rte.host']);
const DEFAULT_PINNED_POOLS = new Set(['live-dad', 'live-mam', 'live-realta-citywest', 'live-realta-parkwest', 'vod-cdn-origin', 'vod-edge-caches']);

export function RealtaCacheLb() {
  const t = useCloudflare(10_000);
  const [search, setSearch] = useState('');

  // Pinned load balancers — a persisted focused view at the top of the page, so CDN-specific load
  // balancers can be kept in sight regardless of search or list order.
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem(PINNED_KEY); return new Set<string>(raw ? JSON.parse(raw) : []); } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned])); } catch { /* storage unavailable — in-memory only */ }
  }, [pinned]);
  const togglePin = (id: string) => setPinned((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const clearPinned = () => setPinned(new Set());

  // Pinned origin pools — a second focused view, so specific pools stay in sight.
  const [pinnedPools, setPinnedPools] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem(POOLS_PINNED_KEY); return new Set<string>(raw ? JSON.parse(raw) : []); } catch { return new Set(); }
  });
  useEffect(() => { try { localStorage.setItem(POOLS_PINNED_KEY, JSON.stringify([...pinnedPools])); } catch { /* storage unavailable */ } }, [pinnedPools]);
  const togglePinPool = (id: string) => setPinnedPools((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const clearPinnedPools = () => setPinnedPools(new Set());

  // Seed the default focused view once (first visit), after the snapshot loads. Matches the default
  // LBs/pools by name → id and merges them in; a seeded flag prevents re-applying over user edits.
  useEffect(() => {
    try { if (localStorage.getItem(SEEDED_KEY)) return; } catch { return; }
    if (t.loadBalancers.length === 0 && t.pools.length === 0) return; // wait for data
    const lbIds = t.loadBalancers.filter((lb) => DEFAULT_PINNED_LBS.has((lb.name ?? '').toLowerCase())).map((lb) => lb.id);
    const poolIds = t.pools.filter((p) => DEFAULT_PINNED_POOLS.has((p.name ?? '').toLowerCase())).map((p) => p.id);
    if (lbIds.length) setPinned((prev) => new Set([...prev, ...lbIds]));
    if (poolIds.length) setPinnedPools((prev) => new Set([...prev, ...poolIds]));
    try { localStorage.setItem(SEEDED_KEY, '1'); } catch { /* storage unavailable — seed each load */ }
  }, [t.loadBalancers, t.pools]);

  const q = search.trim().toLowerCase();

  // The pinned focused views always show the selected LBs/pools, independent of the search filter.
  const pinnedLbs = useMemo(() => t.loadBalancers.filter((lb) => pinned.has(lb.id)), [t.loadBalancers, pinned]);

  // Fast tier — the pinned pools plus the pools referenced by pinned load balancers (capped) are
  // live-refreshed every ~10s; the server enforces the hard cap so this can never overrun rate limits.
  const focusPoolIds = useMemo(() => {
    const ids = new Set<string>(pinnedPools);
    for (const lb of pinnedLbs) for (const p of lb.defaultPools) ids.add(p.poolId);
    return [...ids].slice(0, MAX_FOCUS_POOLS);
  }, [pinnedPools, pinnedLbs]);
  const focused = useCloudflareFocused(focusPoolIds, 10_000);

  // Overlay the fast health/RTT onto the focused pools; every other pool keeps the slow-snapshot values.
  const mergedPools = useMemo(() => t.pools.map((p) => {
    const fresh = focused.byId.get(p.id);
    if (!fresh) return p;
    const byAddr = new Map(fresh.origins.map((o) => [o.address, o]));
    // Overlay only the fast-changing RTT + down-region detail; NEVER the health verdict — Cloudflare's
    // authoritative aggregate (o.healthy from the slow snapshot) stands, so a few far-off check regions
    // failing (e.g. geo-filtered) can't flip an origin to "unhealthy".
    return { ...p, origins: p.origins.map((o) => { const f = byAddr.get(o.address); return f ? { ...o, rttMs: f.rttMs, regionHealth: f.regionHealth } : o; }) };
  }), [t.pools, focused.byId]);

  const pinnedPoolList = useMemo(() => mergedPools.filter((p) => pinnedPools.has(p.id)), [mergedPools, pinnedPools]);

  // Pool-level RTT = mean response time of the pool's enabled origins (from the pool health endpoint).
  const poolRtt = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const p of mergedPools) {
      const rtts = p.origins.filter((o) => o.enabled && o.rttMs !== null).map((o) => o.rttMs as number);
      m.set(p.id, rtts.length > 0 ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10 : null);
    }
    return m;
  }, [mergedPools]);

  /** A load balancer's representative RTT: its default pools' RTT, weighted by steering weight. */
  const lbRtt = (lb: (typeof t.loadBalancers)[number]): number | null => {
    const parts = lb.defaultPools.map((p) => ({ rtt: poolRtt.get(p.poolId) ?? null, w: p.weight ?? 1 })).filter((x): x is { rtt: number; w: number } => x.rtt !== null);
    if (parts.length === 0) return null;
    const wSum = parts.reduce((a, x) => a + x.w, 0) || parts.length;
    return Math.round((parts.reduce((a, x) => a + x.rtt * x.w, 0) / wSum) * 10) / 10;
  };
  const lbRttTitle = (lb: (typeof t.loadBalancers)[number]): string =>
    lb.defaultPools.map((p) => `${p.poolName ?? p.poolId.slice(0, 8)}: ${poolRtt.get(p.poolId) !== null && poolRtt.get(p.poolId) !== undefined ? `${poolRtt.get(p.poolId)} ms` : '—'}`).join('\n');

  /** Pool chips with configured weight + observed share, shared by the focused cards and the table. */
  const poolChips = (lb: (typeof t.loadBalancers)[number]) => {
    if (lb.defaultPools.length === 0) return '—';
    const obsBy = new Map((lb.observed?.byPool ?? []).map((b) => [b.key, b.sharePercent]));
    return lb.defaultPools.map((p) => {
      const share = p.poolName ? obsBy.get(p.poolName) : undefined;
      const rtt = poolRtt.get(p.poolId);
      const bits = [p.weight !== null ? `w${p.weight}` : null, share !== undefined ? `${share}%` : null, rtt !== null && rtt !== undefined ? `${rtt}ms` : null].filter(Boolean).join(' · ');
      return <span key={p.poolId} className="chip selected" title={p.poolName ? undefined : p.poolId}>{p.poolName ?? p.poolId.slice(0, 8)}{bits && <span className="muted"> · {bits}</span>}</span>;
    });
  };
  const loadBalancers = useMemo(
    () => t.loadBalancers.filter((lb) => !q || `${lb.name} ${lb.zoneName ?? ''} ${lb.steeringPolicy} ${lb.defaultPools.map((p) => p.poolName ?? '').join(' ')}`.toLowerCase().includes(q)),
    [t.loadBalancers, q],
  );
  const pools = useMemo(
    () => mergedPools.filter((p) => !q || `${p.name} ${p.origins.map((o) => `${o.name} ${o.address}`).join(' ')}`.toLowerCase().includes(q)),
    [mergedPools, q],
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
        <h1>Load Balancing</h1>
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

      {/* Focused view — pinned load balancers, kept at the top of the page. */}
      {pinnedLbs.length > 0 && (
        <div className="focused-lbs">
          <div className="section-head" style={{ alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Focused load balancers <span className="muted">({pinnedLbs.length})</span> <span className="badge live-countdown" title="Pinned items refresh their health + RTT every ~10s"><span className="live-dot" />live · 10s</span></h2>
            <button className="btn btn-sm" onClick={clearPinned}>Clear all</button>
          </div>
          <div className="grid cols-2">
            {pinnedLbs.map((lb) => (
              <div key={lb.id} className="card focused-lb">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div>
                    <strong>{lb.name}</strong>
                    <div className="muted" style={{ fontSize: '0.72rem' }}>{lb.zoneName ?? ''}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                    <span className={`badge ${lb.enabled ? 'ok' : 'neutral'} badge-sm`}>{lb.enabled ? 'enabled' : 'disabled'}</span>
                    <button className="btn btn-sm" title="Unpin" aria-label={`Unpin ${lb.name}`} onClick={() => togglePin(lb.id)}>✕</button>
                  </div>
                </div>
                <div style={{ marginTop: '0.4rem' }}><span className="chip">{lb.steeringPolicy}</span>{lb.locationStrategy && <span className="muted"> · {lb.locationStrategy}</span>}</div>
                <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>Steers across</div>
                <div className="chip-wrap">{poolChips(lb)}</div>
                <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>
                  {lb.observed ? `${lb.observed.totalRequests.toLocaleString()} reqs (1h)` : 'no observed traffic'} · fallback {lb.fallbackPool?.poolName ?? lb.fallbackPool?.poolId.slice(0, 8) ?? '—'}{lbRtt(lb) !== null ? ` · ${lbRtt(lb)} ms` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Focused view — pinned origin pools, with per-origin RTT + region health. */}
      {pinnedPoolList.length > 0 && (
        <div className="focused-lbs">
          <div className="section-head" style={{ alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Focused pools <span className="muted">({pinnedPoolList.length})</span> <span className="badge live-countdown" title="Pinned pools refresh their health + RTT every ~10s"><span className="live-dot" />live · 10s</span>{focused.capped && <span className="muted" style={{ fontSize: '0.72rem' }}> · some at standard rate (cap {MAX_FOCUS_POOLS})</span>}</h2>
            <button className="btn btn-sm" onClick={clearPinnedPools}>Clear all</button>
          </div>
          <div className="grid cols-2">
            {pinnedPoolList.map((p) => {
              const ph = health(p.healthy);
              return (
                <div key={p.id} className="card focused-lb">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div><strong>{p.name}</strong><div className="muted" style={{ fontSize: '0.72rem' }}>{p.healthyOrigins}/{p.totalOrigins} origins healthy</div></div>
                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                      <span className={`badge ${ph.badge} badge-sm`}>{ph.label}</span>
                      <button className="btn btn-sm" title="Unpin" aria-label={`Unpin ${p.name}`} onClick={() => togglePinPool(p.id)}>✕</button>
                    </div>
                  </div>
                  <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.35rem' }}>{poolDetail(p)}</div>
                  <div className="matrix-wrap" style={{ marginTop: '0.4rem' }}>
                    <table className="matrix"><tbody>
                      {p.origins.map((o) => {
                        const oh = health(o.healthy);
                        return (
                          <tr key={o.name}>
                            <td>{o.name}<div className="muted" style={{ fontSize: '0.68rem' }}>{o.address}</div></td>
                            <td title={rttTitle(o)}>{o.rttMs !== null ? `${o.rttMs} ms` : '—'}</td>
                            <td><span className={`badge ${oh.badge} badge-sm`}>{oh.label}</span></td>
                          </tr>
                        );
                      })}
                    </tbody></table>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
            <tr><th className="col-pin" title="Pin to the focused view"></th><th>Hostname</th><th>Policy · location</th><th>Steers across (pool · weight · observed · rtt)</th><th>Fallback</th><th>RTT</th><th>Observed 1h</th><th>State</th></tr>
          </thead>
          <tbody>
            {loadBalancers.length === 0 && <tr><td colSpan={8} className="center-note">No load balancers.</td></tr>}
            {loadBalancers.map((lb) => {
              const obsTitle = lb.observed
                ? `by region: ${lb.observed.byRegion.map((b) => `${b.key} ${b.sharePercent}%`).join(', ')}\nby PoP: ${lb.observed.byColo.map((b) => `${b.key} ${b.sharePercent}%`).join(', ')}\nby origin: ${lb.observed.byOrigin.map((b) => `${b.key} ${b.sharePercent}%`).join(', ')}`
                : undefined;
              const affinity = lb.sessionAffinity && lb.sessionAffinity !== 'none' ? `affinity: ${lb.sessionAffinity}${lb.sessionAffinityTtl ? ` ${lb.sessionAffinityTtl}s` : ''}` : '';
              const policyDetail = [affinity, lb.adaptiveRoutingFailoverAcrossPools ? 'adaptive failover' : ''].filter(Boolean).join(' · ');
              return (
                <tr key={lb.id} className={pinned.has(lb.id) ? 'row-selected' : ''}>
                  <td className="col-pin"><input type="checkbox" checked={pinned.has(lb.id)} onChange={() => togglePin(lb.id)} aria-label={`Pin ${lb.name}`} /></td>
                  <td>{lb.name}<div className="muted" style={{ fontSize: '0.72rem' }}>{lb.zoneName ?? ''}</div></td>
                  <td><span className="chip">{lb.steeringPolicy}</span>{lb.locationStrategy && <span className="muted"> · {lb.locationStrategy}</span>}
                    {policyDetail && <div className="muted" style={{ fontSize: '0.72rem' }}>{policyDetail}</div>}
                  </td>
                  <td>
                    <div className="chip-wrap">{poolChips(lb)}{Object.keys(lb.regionPools).length > 0 && <span className="muted">+region overrides</span>}</div>
                  </td>
                  <td className="muted">{lb.fallbackPool?.poolName ?? lb.fallbackPool?.poolId.slice(0, 8) ?? '—'}</td>
                  <td title={lbRttTitle(lb)}>{lbRtt(lb) !== null ? `${lbRtt(lb)} ms` : '—'}</td>
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
            <tr><th className="col-pin" title="Pin pool to the focused view"></th><th>Pool / origin</th><th>Address</th><th>Weight</th><th>RTT</th><th>Health</th></tr>
          </thead>
          <tbody>
            {pools.length === 0 && <tr><td colSpan={6} className="center-note">No pools.</td></tr>}
            {pools.map((p) => {
              const ph = health(p.healthy);
              return [
                <tr key={p.id} className={`lag-parent ${pinnedPools.has(p.id) ? 'row-selected' : ''}`}>
                  <td className="col-pin"><input type="checkbox" checked={pinnedPools.has(p.id)} onChange={() => togglePinPool(p.id)} aria-label={`Pin ${p.name}`} /></td>
                  <td>{p.name} <span className="muted">· {p.healthyOrigins}/{p.totalOrigins} origins healthy</span>
                    {p.healthCheck && <div className="muted" style={{ fontSize: '0.72rem' }}>check: {p.healthCheck.method ?? p.healthCheck.type} {p.healthCheck.path ?? ''} → {p.healthCheck.expectedCodes ?? ''}{p.healthCheck.expectedBody ? ` "${p.healthCheck.expectedBody}"` : ''}{p.healthCheck.port ? ` :${p.healthCheck.port}` : ''}</div>}
                    <div className="muted" style={{ fontSize: '0.72rem' }}>{poolDetail(p)}</div>
                  </td>
                  <td className="muted">{p.description ?? '—'}</td>
                  <td>{!p.enabled && <span className="badge neutral badge-sm">disabled</span>}</td>
                  <td></td>
                  <td><span className={`badge ${ph.badge}`}>{ph.label}</span></td>
                </tr>,
                ...p.origins.map((o) => {
                  const oh = health(o.healthy);
                  return (
                    <tr key={`${p.id}::${o.name}`} className="lag-member">
                      <td className="col-pin"></td>
                      <td className="itf-member" title={o.hostHeader ? `Host: ${o.hostHeader}` : undefined}><span className="tree-branch">└─ </span>{o.name}</td>
                      <td className="muted">{o.address}</td>
                      <td>{o.weight}</td>
                      <td title={rttTitle(o)}>{o.rttMs !== null ? `${o.rttMs} ms` : '—'}</td>
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

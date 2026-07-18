// NOC dashboard — an at-a-glance operations view: how the active steering record is served across
// ISPs, the busiest edge interfaces, and the pinned origin pools. Each links to its full page.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useCloudVision } from '../telemetry/use-cloudvision';
import { useCloudflare } from '../telemetry/use-cloudflare';
import { IspSteeringOverview } from '../features/IspSteeringOverview';
import { formatBps, formatPercent } from '../telemetry/format';
import { ispToScenario } from '../steering/isps';
import type { Ns1ActiveRecordResponse } from '../api/types';

const POOLS_PINNED_KEY = 'radar.cacheLb.pinnedPools';
const healthBadge = (ok: boolean | null): { badge: string; label: string } =>
  ok === true ? { badge: 'ok', label: 'healthy' } : ok === false ? { badge: 'danger', label: 'unhealthy' } : { badge: 'neutral', label: 'unknown' };

// --- Steering overview (every ISP), on the currently-active steering record ---
function SteeringSection() {
  const navigate = useNavigate();
  const [active, setActive] = useState<Ns1ActiveRecordResponse | null>(null);
  useEffect(() => {
    api.activeRecord().then(setActive).catch(() => setActive(null));
  }, []);
  const a = active?.active ?? null;
  return (
    <div className="card">
      {a ? (
        <IspSteeringOverview
          zone={a.zone}
          domain={a.domain}
          type={a.type}
          onPick={(isp) => navigate(`/explorer/${a.zone}/${a.domain}/${a.type}`, { state: { prefill: { zone: a.zone, domain: a.domain, type: a.type, ...ispToScenario(isp) } } })}
        />
      ) : active ? (
        <div className="notice warn">Active steering record could not be resolved{active.warnings?.[0] ? ` — ${active.warnings[0]}` : ''}.</div>
      ) : (
        <div className="muted">Resolving the active steering record…</div>
      )}
    </div>
  );
}

// --- Top 10 edge interfaces by current bandwidth (excludes LAG members) ---
function TopInterfacesSection() {
  const t = useCloudVision(15_000);
  const top = useMemo(
    () => t.interfaces.filter((i) => i.memberOf === null && i.primaryBps !== null).sort((x, y) => (y.primaryBps ?? 0) - (x.primaryBps ?? 0)).slice(0, 10),
    [t.interfaces],
  );
  return (
    <div className="card">
      <div className="step-head">
        <h3 style={{ margin: 0 }}>Top 10 network interfaces</h3>
        <Link className="ghost" style={{ marginLeft: 'auto' }} to="/network">Network Telemetry →</Link>
      </div>
      {t.mode === 'disabled' ? (
        <div className="notice info">Network telemetry not connected.</div>
      ) : top.length === 0 ? (
        <span className="muted">Loading…</span>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead><tr><th>Router</th><th>Interface</th><th>Provider</th><th>Bandwidth</th><th>Util</th></tr></thead>
            <tbody>
              {top.map((i) => (
                <tr key={`${i.deviceId}::${i.name}`}>
                  <td>{i.deviceHostname}</td>
                  <td>{i.name}{i.description ? <div className="muted" style={{ fontSize: '0.68rem' }}>{i.description}</div> : null}</td>
                  <td>{i.provider ?? '—'}</td>
                  <td>{formatBps(i.primaryBps)}</td>
                  <td>{formatPercent(i.utilisationPercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Focused origin pools (the ones pinned on the Load Balancing page) ---
function FocusedPoolsSection() {
  const t = useCloudflare(15_000);
  const [pinnedIds] = useState<string[]>(() => {
    try { const raw = localStorage.getItem(POOLS_PINNED_KEY); return raw ? (JSON.parse(raw) as string[]) : []; } catch { return []; }
  });
  const pools = useMemo(() => t.pools.filter((p) => pinnedIds.includes(p.id)), [t.pools, pinnedIds]);
  return (
    <div className="card">
      <div className="step-head">
        <h3 style={{ margin: 0 }}>Focused pools</h3>
        <Link className="ghost" style={{ marginLeft: 'auto' }} to="/load-balancing">Load Balancing →</Link>
      </div>
      {pinnedIds.length === 0 ? (
        <div className="notice info">No pinned pools yet — pin origin pools on the Load Balancing page to watch them here.</div>
      ) : pools.length === 0 ? (
        <span className="muted">Loading…</span>
      ) : (
        <div className="grid cols-2">
          {pools.map((p) => {
            const ph = healthBadge(p.healthy);
            return (
              <div key={p.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div><strong>{p.name}</strong><div className="muted" style={{ fontSize: '0.72rem' }}>{p.healthyOrigins}/{p.totalOrigins} origins healthy</div></div>
                  <span className={`badge ${ph.badge}`}>{ph.label}</span>
                </div>
                <div className="matrix-wrap" style={{ marginTop: '0.4rem' }}>
                  <table className="matrix"><tbody>
                    {p.origins.map((o) => {
                      const oh = healthBadge(o.healthy);
                      return (
                        <tr key={o.name}>
                          <td>{o.name}<div className="muted" style={{ fontSize: '0.68rem' }}>{o.address}</div></td>
                          <td>{o.rttMs !== null ? `${o.rttMs} ms` : '—'}</td>
                          <td><span className={`badge ${oh.badge}`}>{oh.label}</span></td>
                        </tr>
                      );
                    })}
                  </tbody></table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const { principal, hasPermission } = useAuth();
  const canSteer = hasPermission('dns.explain.read');
  const canTopology = hasPermission('topology.summary.read');

  return (
    <div>
      <div className="page-head">
        <h1>Delivery Steering — NOC Overview</h1>
        <p>Welcome{principal?.displayName ? `, ${principal.displayName}` : ''}. RADAR explains NS1 steering; it never changes it (read-only v1).</p>
      </div>

      {canSteer ? <SteeringSection /> : (
        <div className="card"><div className="muted">Steering overview requires the Viewing Engineer role.</div></div>
      )}

      {canTopology && (
        <div className="grid cols-2" style={{ alignItems: 'flex-start' }}>
          <TopInterfacesSection />
          <FocusedPoolsSection />
        </div>
      )}
    </div>
  );
}

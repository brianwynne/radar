// Application shell: header, permission-filtered navigation, principal chip, and the global
// LIVE mode banner (the mock banner is intentionally suppressed — synthetic data is flagged
// per-view by the provenance tags). Navigation hiding is cosmetic — the API enforces RBAC.
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import type { Ns1Status } from '../api/types';

// How each authentication mode is shown in the principal chip.
const AUTH_METHOD_LABEL: Record<string, string> = {
  dev: 'development authentication',
  oidc: 'Microsoft Entra ID',
  'cf-access': 'Cloudflare Access',
};

const NAV = [
  { to: '/', label: 'Dashboard', perm: 'dashboard.read', end: true },
  { to: '/live-steering', label: 'Live Steering', perm: 'steering.summary.read', end: false },
  // Hidden until complete — routes remain, just unlinked from the nav.
  // { to: '/steering', label: 'Steering', perm: 'steering.summary.read', end: false },
  // { to: '/topology', label: 'Topology', perm: 'topology.summary.read', end: false },
  { to: '/network', label: 'Network Telemetry', perm: 'topology.summary.read', end: true },
  { to: '/bgp-intelligence', label: 'BGP Intelligence', perm: 'topology.summary.read', end: false },
  { to: '/load-balancing', label: 'Load Balancing', perm: 'topology.summary.read', end: false },
  { to: '/cdn', label: 'Commercial CDN', perm: 'topology.summary.read', end: false },
  { to: '/explorer', label: 'NS1 Explorer', perm: 'ns1.detail.read', end: false },
  // Hidden from the nav — routes remain, still reachable by URL.
  // { to: '/validation/ns1', label: 'NS1 Validation', perm: 'ns1.detail.read', end: false },
  // { to: '/activity', label: 'Activity', perm: 'audit.read', end: false },
  { to: '/network/connection', label: 'Integrations', perm: 'connector.manage', end: false },
  // { to: '/settings', label: 'Settings', perm: 'mapping.manage', end: false },
];

export function AppShell() {
  const { principal, hasPermission } = useAuth();
  const [mode, setMode] = useState<Ns1Status | null>(null);

  useEffect(() => {
    api.ns1Config().then(setMode).catch(() => setMode(null));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <svg className="brand-logo" viewBox="0 0 24 24" width="30" height="30" role="img" aria-label="RaDAR logo">
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.3" />
            <circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.3" />
            <path d="M12 12 L12 2.5 A9.5 9.5 0 0 1 20.5 8 Z" fill="currentColor" opacity="0.25" />
            <line x1="12" y1="12" x2="12" y2="2.5" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          </svg>
          <span className="brand-name">RaDAR<small>Réalta Delivery Analysis &amp; Routing</small></span>
        </div>
        <nav className="nav">
          {NAV.filter((n) => hasPermission(n.perm)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {principal && (
          <div className="principal">
            <div>
              <b>{principal.displayName ?? principal.subject}</b>
              {principal.roles.map((r) => (
                <span key={r} className="role-chip">
                  {r}
                </span>
              ))}
            </div>
            {principal.email && principal.email !== principal.displayName && <div className="principal-email mono">{principal.email}</div>}
            <div>{AUTH_METHOD_LABEL[principal.authenticationMethod] ?? principal.authenticationMethod}</div>
          </div>
        )}
      </header>
      {mode && mode.mode !== 'mock' && (
        <div className="mode-banner live" role="status">LIVE — read-only NS1 Connect data.</div>
      )}
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

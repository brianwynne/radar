// Application shell: header, permission-filtered navigation, principal chip, and the
// global mock/live mode banner. Navigation hiding is cosmetic — the API enforces RBAC.
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import type { Ns1Status } from '../api/types';

const NAV = [
  { to: '/', label: 'Dashboard', perm: 'dashboard.read', end: true },
  { to: '/explain', label: 'Explain', perm: 'dns.explain.read', end: false },
  { to: '/steering', label: 'Steering', perm: 'steering.summary.read', end: false },
  { to: '/topology', label: 'Topology', perm: 'topology.summary.read', end: false },
  { to: '/explorer', label: 'NS1 Explorer', perm: 'ns1.detail.read', end: false },
  { to: '/activity', label: 'Activity', perm: 'audit.read', end: false },
  { to: '/settings', label: 'Settings', perm: 'mapping.manage', end: false },
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
          RADAR<small>Réalta Adaptive Delivery Analysis &amp; Routing</small>
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
            <div>{principal.authenticationMethod === 'dev' ? 'development authentication' : 'Microsoft Entra ID'}</div>
          </div>
        )}
      </header>
      {mode && (
        <div className={`mode-banner ${mode.mode}`} role="status">
          {mode.mode === 'mock'
            ? 'MOCK MODE — data is SYNTHETIC and NON-PRODUCTION. Not real RTÉ or NS1 configuration.'
            : 'LIVE — read-only NS1 Connect data.'}
        </div>
      )}
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

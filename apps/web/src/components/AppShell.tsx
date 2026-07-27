// Application shell: header, permission-filtered navigation, principal chip, and the global
// LIVE mode banner (the mock banner is intentionally suppressed — synthetic data is flagged
// per-view by the provenance tags). Navigation hiding is cosmetic — the API enforces RBAC.
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import type { Ns1Status } from '../api/types';
import { SetPageBanner } from './page-banner';

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
  // BGP Intelligence now lives inside Network Telemetry as a tab (RIPE + BGP.Tools); route kept for direct links.
  { to: '/load-balancing', label: 'DNS Load Balancing', perm: 'topology.summary.read', end: false },
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
  // A page may take over the top banner (e.g. the Commercial CDN page shows live-delivery status there).
  const [pageBanner, setPageBanner] = useState<ReactNode | null>(null);

  useEffect(() => {
    api.ns1Config().then(setMode).catch(() => setMode(null));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {/* Animated radar: a blue beam sweeping across the island of Ireland (green outline). */}
          <svg className="brand-logo" viewBox="0 0 100 120" width="34" height="41" role="img" aria-label="RaDAR logo — radar sweeping the island of Ireland">
            <defs>
              <path id="ie-outline" d="M48 8 L58 14 L64 21 L59 29 L66 34 L63 44 L70 57 L65 69 L71 86 L58 98 L48 108 L37 104 L27 96 L21 85 L16 73 L13 60 L21 54 L14 46 L21 38 L13 32 L23 26 L31 18 L40 12 Z" />
              <clipPath id="ie-clip"><use href="#ie-outline" /></clipPath>
            </defs>
            {/* Everything inside the coastline is clipped to the island shape. */}
            <g clipPath="url(#ie-clip)">
              <use href="#ie-outline" fill="#2ecc71" opacity="0.10" />
              <circle cx="42" cy="58" r="20" fill="none" stroke="#4aa3ff" strokeWidth="1" opacity="0.18" />
              <circle cx="42" cy="58" r="40" fill="none" stroke="#4aa3ff" strokeWidth="1" opacity="0.14" />
              <g>
                <path d="M42 58 L104 58 A62 62 0 0 0 89.5 18.1 Z" fill="#4aa3ff" opacity="0.28" />
                <line x1="42" y1="58" x2="104" y2="58" stroke="#4aa3ff" strokeWidth="2" opacity="0.9" />
                <animateTransform attributeName="transform" type="rotate" from="0 42 58" to="360 42 58" dur="4s" repeatCount="indefinite" />
              </g>
            </g>
            <use href="#ie-outline" fill="none" stroke="#2ecc71" strokeWidth="2.4" strokeLinejoin="round" />
            <circle cx="42" cy="58" r="2.4" fill="#4aa3ff" />
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
      {(pageBanner || (mode && mode.mode !== 'mock')) && (
        <div className={`mode-banner ${pageBanner ? 'page' : 'live'}`} role="status">
          {pageBanner ?? 'LIVE — read-only NS1 Connect data.'}
        </div>
      )}
      <SetPageBanner.Provider value={setPageBanner}>
        <main className="content">
          <Outlet />
        </main>
      </SetPageBanner.Provider>
    </div>
  );
}

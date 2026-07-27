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
          {/* Animated radar: a blue beam sweeping across the island of Ireland (green coastline).
              The outline is a real Ireland silhouette (32-county coastline dissolved to a single
              island, traced and simplified) so it is geographically faithful, not stylised. */}
          <svg className="brand-logo" viewBox="0 0 170 220" width="37" height="48" role="img" aria-label="RaDAR logo — radar sweeping the island of Ireland">
            <defs>
              <path id="ie-outline" d="M106 4 L120 11 L111 17 L110 22 L134 11 L147 13 L150 25 L160 35 L153 44 L164 42 L168 52 L161 66 L155 65 L149 76 L143 72 L146 78 L140 77 L137 81 L147 102 L148 112 L143 115 L149 129 L143 158 L134 168 L139 175 L124 175 L122 178 L119 173 L118 179 L99 181 L99 187 L77 197 L68 208 L64 206 L62 210 L58 208 L46 215 L40 216 L36 212 L27 216 L35 209 L27 211 L39 204 L36 200 L24 205 L27 207 L16 208 L30 196 L19 200 L14 199 L14 195 L10 198 L8 192 L24 182 L21 179 L6 181 L6 177 L20 171 L22 175 L27 173 L27 166 L23 164 L30 162 L33 156 L43 154 L35 152 L24 156 L38 146 L44 125 L55 123 L53 118 L36 120 L35 117 L31 120 L31 116 L34 118 L31 112 L24 116 L24 112 L16 109 L19 106 L15 102 L26 100 L25 91 L32 91 L35 86 L32 83 L24 85 L24 81 L22 85 L19 80 L14 80 L19 77 L26 80 L21 66 L17 73 L19 64 L25 65 L27 60 L42 61 L49 69 L52 63 L69 64 L70 61 L64 59 L78 52 L83 45 L64 44 L60 40 L75 32 L71 24 L77 16 L86 12 L90 17 L97 9 L102 20 L101 12 L107 5 Z" />
              <clipPath id="ie-clip"><use href="#ie-outline" /></clipPath>
            </defs>
            {/* Everything inside the coastline is clipped to the island shape. */}
            <g clipPath="url(#ie-clip)">
              <use href="#ie-outline" fill="#2ecc71" opacity="0.10" />
              <circle cx="89" cy="110" r="40" fill="none" stroke="#4aa3ff" strokeWidth="2" opacity="0.18" />
              <circle cx="89" cy="110" r="80" fill="none" stroke="#4aa3ff" strokeWidth="2" opacity="0.14" />
              <g>
                <path d="M89 110 L219 110 A130 130 0 0 0 188.6 26.4 Z" fill="#4aa3ff" opacity="0.28" />
                <line x1="89" y1="110" x2="219" y2="110" stroke="#4aa3ff" strokeWidth="4" opacity="0.9" />
                <animateTransform attributeName="transform" type="rotate" from="0 89 110" to="360 89 110" dur="4s" repeatCount="indefinite" />
              </g>
              {/* Dublin origin blip (RADAR's CTW/PKW datacentres) — pings as the beam sweeps past (east). */}
              <circle cx="136" cy="111" r="3.5" fill="#4aa3ff">
                <animate attributeName="opacity" values="1;0.25;0.25;1" keyTimes="0;0.08;0.92;1" dur="4s" repeatCount="indefinite" />
                <animate attributeName="r" values="6;3.5;3.5;6" keyTimes="0;0.08;0.92;1" dur="4s" repeatCount="indefinite" />
              </circle>
            </g>
            <use href="#ie-outline" fill="none" stroke="#2ecc71" strokeWidth="4.5" strokeLinejoin="round" strokeLinecap="round" />
            <circle cx="89" cy="110" r="5" fill="#4aa3ff" />
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

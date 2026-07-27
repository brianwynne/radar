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
  // { to: '/settings', label: 'Settings', perm: 'mapping.manage', end: false },
];

// Integrations is token/connector configuration, not a dashboard — it lives on the right, by the
// principal chip, rather than among the main navigation.
const INTEGRATIONS_NAV = { to: '/network/connection', label: 'Integrations', perm: 'connector.manage', end: false };

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
                <animateTransform attributeName="transform" type="rotate" from="0 89 110" to="360 89 110" dur="8s" repeatCount="indefinite" />
              </g>
            </g>
            <use href="#ie-outline" fill="none" stroke="#2ecc71" strokeWidth="4.5" strokeLinejoin="round" strokeLinecap="round" />
            {/* Edge PoPs across the island — content delivered from the Dublin origin. Each city's
                blue ring ripples outward as the sweep beam reaches it (begin = its bearing / 8s). */}
            <g>
              {/* Dublin — RTÉ origin (CTW/PKW) */}
              <circle cx="142" cy="114" r="5" fill="#4aa3ff" />
              <circle cx="142" cy="114" r="5" fill="none" stroke="#8fd0ff" strokeWidth="1.5"><animate attributeName="r" values="5;9;5" dur="2.6s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.9;0;0.9" dur="2.6s" repeatCount="indefinite" /></circle>
              {/* Cork */}
              <circle cx="71" cy="193" r="3" fill="#2ecc71" />
              <circle cx="71" cy="193" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="2.27s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="2.27s" repeatCount="indefinite" /></circle>
              <circle cx="71" cy="193" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="2.27s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="2.27s" repeatCount="indefinite" /></circle>
              {/* Limerick */}
              <circle cx="66" cy="152" r="3" fill="#2ecc71" />
              <circle cx="66" cy="152" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="2.64s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="2.64s" repeatCount="indefinite" /></circle>
              <circle cx="66" cy="152" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="2.64s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="2.64s" repeatCount="indefinite" /></circle>
              {/* Galway */}
              <circle cx="52" cy="118" r="3" fill="#2ecc71" />
              <circle cx="52" cy="118" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="3.73s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="3.73s" repeatCount="indefinite" /></circle>
              <circle cx="52" cy="118" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="3.73s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="3.73s" repeatCount="indefinite" /></circle>
              {/* Waterford */}
              <circle cx="115" cy="173" r="3" fill="#2ecc71" />
              <circle cx="115" cy="173" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="1.5s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="1.5s" repeatCount="indefinite" /></circle>
              <circle cx="115" cy="173" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="1.5s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="1.5s" repeatCount="indefinite" /></circle>
              {/* Belfast */}
              <circle cx="153" cy="46" r="3" fill="#2ecc71" />
              <circle cx="153" cy="46" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="7s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="7s" repeatCount="indefinite" /></circle>
              <circle cx="153" cy="46" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="7s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="7s" repeatCount="indefinite" /></circle>
              {/* Derry */}
              <circle cx="108" cy="24" r="3" fill="#2ecc71" />
              <circle cx="108" cy="24" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="6.28s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="6.28s" repeatCount="indefinite" /></circle>
              <circle cx="108" cy="24" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="6.28s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="6.28s" repeatCount="indefinite" /></circle>
              {/* Sligo */}
              <circle cx="71" cy="64" r="3" fill="#2ecc71" />
              <circle cx="71" cy="64" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="5.53s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="5.53s" repeatCount="indefinite" /></circle>
              <circle cx="71" cy="64" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="5.53s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="5.53s" repeatCount="indefinite" /></circle>
              {/* Letterkenny */}
              <circle cx="95" cy="27" r="3" fill="#2ecc71" />
              <circle cx="95" cy="27" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="6.09s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="6.09s" repeatCount="indefinite" /></circle>
              <circle cx="95" cy="27" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="6.09s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="6.09s" repeatCount="indefinite" /></circle>
              {/* Kilkenny */}
              <circle cx="110" cy="152" r="3" fill="#2ecc71" />
              <circle cx="110" cy="152" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="1.41s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="1.41s" repeatCount="indefinite" /></circle>
              <circle cx="110" cy="152" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="1.41s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="1.41s" repeatCount="indefinite" /></circle>
              {/* Wexford */}
              <circle cx="136" cy="169" r="3" fill="#2ecc71" />
              <circle cx="136" cy="169" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="1.14s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="1.14s" repeatCount="indefinite" /></circle>
              <circle cx="136" cy="169" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="1.14s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="1.14s" repeatCount="indefinite" /></circle>
              {/* Drogheda */}
              <circle cx="139" cy="94" r="3" fill="#2ecc71" />
              <circle cx="139" cy="94" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="7.61s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="7.61s" repeatCount="indefinite" /></circle>
              <circle cx="139" cy="94" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="7.61s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="7.61s" repeatCount="indefinite" /></circle>
              {/* Athlone (centre of Ireland — sits on the radar pivot) */}
              <circle cx="88" cy="110" r="3" fill="#2ecc71" />
              <circle cx="88" cy="110" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="4s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="4s" repeatCount="indefinite" /></circle>
              <circle cx="88" cy="110" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="4s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="4s" repeatCount="indefinite" /></circle>
              {/* Tralee */}
              <circle cx="31" cy="173" r="3" fill="#2ecc71" />
              <circle cx="31" cy="173" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="2.95s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="2.95s" repeatCount="indefinite" /></circle>
              <circle cx="31" cy="173" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="2.95s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="2.95s" repeatCount="indefinite" /></circle>
              {/* Ennis */}
              <circle cx="54" cy="142" r="3" fill="#2ecc71" />
              <circle cx="54" cy="142" fill="#ecfff4"><animate attributeName="r" values="3;7.5;3;3" keyTimes="0;0.05;0.12;1" dur="8s" begin="3.06s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.05;0.12;1" dur="8s" begin="3.06s" repeatCount="indefinite" /></circle>
              <circle cx="54" cy="142" fill="none" stroke="#bfe8ff" strokeWidth="2.6"><animate attributeName="r" values="3;17;17" keyTimes="0;0.18;1" dur="8s" begin="3.06s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0;0" keyTimes="0;0.18;1" dur="8s" begin="3.06s" repeatCount="indefinite" /></circle>
            </g>
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
        {hasPermission(INTEGRATIONS_NAV.perm) && (
          <NavLink
            to={INTEGRATIONS_NAV.to}
            end={INTEGRATIONS_NAV.end}
            className={({ isActive }) => `nav-aux${isActive ? ' active' : ''}`}
            title="Integrations — connector & token configuration"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            <span>Integrations</span>
          </NavLink>
        )}
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

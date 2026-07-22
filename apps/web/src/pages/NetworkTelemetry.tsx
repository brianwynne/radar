// Network Telemetry — read-only CloudVision operational view. Summary tiles, a Devices list, a
// top-interfaces-by-utilisation table, a filterable interface table, and a BGP table. Everything
// is informational (RADAR issues no writes); configured facts (capacity, classification) are
// shown distinctly from observed telemetry, and a missing/stale value is shown as such —
// never invented. Auto-refreshes; clearly indicates stale data.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useCloudVision } from '../telemetry/use-cloudvision';
import { formatBps, formatPercent, formatFreshness } from '../telemetry/format';
import { healthMeta, bgpMeta, operMeta, bandwidthSourceMeta } from '../telemetry/cv-format';
import { ResolverView } from '../features/ResolverView';
import { DcBandwidth } from '../features/DcBandwidth';
import type { LinkType, NetworkHealth, NetworkInterface } from '../api/types';

const LINK_TYPES: LinkType[] = ['PRIVATE_PEERING', 'IX_PEERING', 'TRANSIT', 'INTERNAL', 'UNKNOWN'];
const HEALTHS: NetworkHealth[] = ['healthy', 'warning', 'critical', 'down', 'unavailable', 'unknown'];

function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : String(n));

// Colour a BGP connection type: PNI (dedicated) green, INEX (exchange) info, Transit amber.
const connBadge = (t: string): string => (t === 'PNI' ? 'ok' : t === 'Transit' ? 'warn' : t === 'INEX' ? 'info' : 'neutral');

// Link-type groups matching the summary's Peering / Transit totals.
const PEERING_TYPES: LinkType[] = ['PRIVATE_PEERING', 'IX_PEERING'];
const TRANSIT_TYPES: LinkType[] = ['TRANSIT'];
// Short interface label for the cramped tile list: Port-Channel1 → Po1, Ethernet3/1 → Et3/1.
const shortIf = (name: string): string => name.replace(/^Port-Channel/, 'Po').replace(/^Ethernet/, 'Et');

// Configured-capacity breakdown for one link-type group: one row per link (LAG members excluded,
// so it matches the corresponding throughput total, whose bundle already stands for its members),
// biggest first, plus the summed capacity. Speeds are CONFIGURED, not live traffic.
const linksOfTypes = (interfaces: NetworkInterface[], types: LinkType[]): NetworkInterface[] =>
  interfaces
    .filter((i) => types.includes(i.linkType) && i.memberOf === null)
    .sort((a, b) => (b.speedBps ?? 0) - (a.speedBps ?? 0));
const sumCapacityBps = (links: NetworkInterface[]): number | null => {
  const speeds = links.map((i) => i.speedBps).filter((s): s is number => s !== null);
  return speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) : null;
};

// The list rendered inside a summary tile (Peering, Transit) under its live throughput number.
function CapacityBreakdown({ links, totalBps }: { links: NetworkInterface[]; totalBps: number | null }) {
  if (links.length === 0) return null;
  return (
    <div className="tile-list">
      <div className="tile-list-head" title="Configured capacity of each link — not live traffic">Configured capacity by link</div>
      {links.map((i) => (
        <div className="tile-list-row" key={`${i.deviceId}::${i.name}`} title={`${i.deviceHostname} · ${i.name}${i.description ? ` · ${i.description}` : ''}`}>
          <span className="tile-list-label">{i.provider ?? i.name}{i.provider && <span className="muted"> {shortIf(i.name)}</span>}</span>
          <span className="tile-list-val">{formatBps(i.speedBps)}</span>
        </div>
      ))}
      <div className="tile-list-row total">
        <span className="tile-list-label">Total capacity</span>
        <span className="tile-list-val">{formatBps(totalBps)}</span>
      </div>
    </div>
  );
}

// Utilisation colour level with hysteresis. A link turns amber at 60% of capacity and red at
// 80%, but only clears back once it drops a few points below (55% / 75%) — so the colour does
// not bounce as the 10-second bandwidth jitters around a threshold. `prev` is the level from the
// previous poll; the transition is single-step and a fixed point when re-applied to the same
// value (so re-rendering with unchanged data never advances it).
export type UtilLevel = 'ok' | 'warn' | 'crit';
const RISE_WARN = 60;
const FALL_WARN = 55;
const RISE_CRIT = 80;
const FALL_CRIT = 75;
export function nextUtilLevel(util: number | null, prev: UtilLevel): UtilLevel {
  if (util === null || !Number.isFinite(util)) return 'ok'; // no measurable load → no colour
  if (prev === 'crit') return util < FALL_CRIT ? (util < FALL_WARN ? 'ok' : 'warn') : 'crit';
  if (prev === 'warn') return util >= RISE_CRIT ? 'crit' : util < FALL_WARN ? 'ok' : 'warn';
  return util >= RISE_CRIT ? 'crit' : util >= RISE_WARN ? 'warn' : 'ok';
}
const utilClass = (lvl: UtilLevel): string | undefined => (lvl === 'crit' ? 'util-crit' : lvl === 'warn' ? 'util-warn' : undefined);

export function NetworkTelemetry() {
  // Poll on CloudVision's ~10-second publish grid — the interface `rates` node republishes
  // every ~10s, so this is the freshest the analytics API meaningfully offers.
  const t = useCloudVision(10_000);
  const [tab, setTab] = useState<'telemetry' | 'bandwidth' | 'resolvers'>('telemetry');
  const [provider, setProvider] = useState('');
  const [linkType, setLinkType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [device, setDevice] = useState(''); // selected device id (drill-down)
  const [hideIdle, setHideIdle] = useState(true); // default ON: hide ports carrying no traffic (0 b/s either direction)
  const [bgpProvider, setBgpProvider] = useState(''); // BGP-table filters
  const [bgpAsn, setBgpAsn] = useState('');
  const [bgpOpen, setBgpOpen] = useState<Set<string>>(new Set()); // expanded provider groups
  const toggleBgp = (k: string) => setBgpOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const [sort, setSort] = useState<{ col: 'name' | 'current' | 'util'; dir: 'asc' | 'desc' }>({ col: 'name', dir: 'asc' });
  const sortBy = (col: 'name' | 'current' | 'util') => setSort((s) => (s.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' ? 'asc' : 'desc' }));
  const arrow = (col: 'name' | 'current' | 'util') => (sort.col === col ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '');
  const ifKey = (deviceId: string, name: string) => `${deviceId}::${name}`;

  const selectedDevice = t.devices.find((d) => d.id === device) ?? null;
  const toggleDevice = (id: string) => setDevice((cur) => (cur === id ? '' : id));

  const providers = useMemo(() => [...new Set(t.interfaces.map((i) => i.provider).filter((p): p is string => !!p))].sort(), [t.interfaces]);

  // Busiest links: the top 10 interfaces by current bandwidth, scoped to the selected router
  // (follows the Router filter). Excludes LAG members (their Port-Channel already represents
  // their load) so the slots are distinct links.
  const topInterfaces = useMemo(
    () =>
      t.interfaces
        .filter((i) => (!device || i.deviceId === device) && i.memberOf === null && i.primaryBps !== null)
        .sort((a, b) => (b.primaryBps ?? 0) - (a.primaryBps ?? 0))
        .slice(0, 10),
    [t.interfaces, device],
  );

  // Configured capacity per link for the Peering and Transit tiles. Global (not scoped to the
  // Router filter) to mirror the summary tiles these lists sit under.
  const peeringLinks = useMemo(() => linksOfTypes(t.interfaces, PEERING_TYPES), [t.interfaces]);
  const transitLinks = useMemo(() => linksOfTypes(t.interfaces, TRANSIT_TYPES), [t.interfaces]);
  const peeringCapacityBps = useMemo(() => sumCapacityBps(peeringLinks), [peeringLinks]);
  const transitCapacityBps = useMemo(() => sumCapacityBps(transitLinks), [transitLinks]);

  // Hysteretic utilisation colour level per interface. Advanced once per poll (keyed on the
  // interface array identity) and remembered across polls in a ref, so a link hovering at a
  // threshold keeps a stable colour instead of flickering. Computed over ALL interfaces (not the
  // filtered view) so the level survives filtering a link out and back in.
  const levelsRef = useRef<Map<string, UtilLevel>>(new Map());
  const levelByKey = useMemo(() => {
    const next = new Map<string, UtilLevel>();
    for (const i of t.interfaces) {
      const key = `${i.deviceId}::${i.name}`;
      next.set(key, nextUtilLevel(i.utilisationPercent, levelsRef.current.get(key) ?? 'ok'));
    }
    levelsRef.current = next;
    return next;
  }, [t.interfaces]);

  // Interface lookup (deviceId::name) to correlate each BGP peer with the physical link it runs on.
  const itfByKey = useMemo(() => new Map(t.interfaces.map((i) => [`${i.deviceId}::${i.name}`, i])), [t.interfaces]);

  const interfaces = useMemo(
    () =>
      t.interfaces.filter((i) => {
        if (device && i.deviceId !== device) return false;
        if (provider && i.provider !== provider) return false;
        if (linkType && i.linkType !== linkType) return false;
        if (status && i.status !== status) return false;
        if (hideIdle && Math.max(i.inBps ?? 0, i.outBps ?? 0) === 0) return false; // no traffic ⇒ unused port
        if (search) {
          const q = search.toLowerCase();
          if (!`${i.name} ${i.description ?? ''} ${i.deviceHostname}`.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [t.interfaces, device, provider, linkType, status, search, hideIdle],
  );

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // Copy the top-interfaces table to the clipboard as a real HTML table (so it pastes as a table
  // into Word/Docs/email), with a tab-separated plain-text fallback for plain targets.
  const [copiedTop, setCopiedTop] = useState(false);
  const copyTopInterfaces = async () => {
    const header = ['Router', 'Interface', 'Description', 'Provider', 'Capacity', 'Current', 'Util'];
    const body = topInterfaces.map((i) => [
      i.deviceHostname, i.name, i.description ?? '', i.provider ?? '',
      formatBps(i.speedBps), formatBps(i.primaryBps), formatPercent(i.utilisationPercent),
    ]);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html =
      `<table border="1" cellspacing="0" cellpadding="4"><thead><tr>${header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const tsv = [header, ...body].map((r) => r.join('\t')).join('\n');
    try {
      if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) }),
        ]);
      } else {
        await navigator.clipboard.writeText(tsv); // older browsers / insecure context
      }
      setCopiedTop(true);
      setTimeout(() => setCopiedTop(false), 1500);
    } catch {
      // clipboard unavailable — silently no-op
    }
  };

  // Build the interface tree: Port-Channels + standalone ports at the top level (sorted),
  // each LAG's member ports indented beneath it. Members are excluded from the top-level
  // sort so a Port-Channel stays grouped with its members.
  const rows = useMemo(() => {
    type Itf = (typeof interfaces)[number];
    const cmp = (a: Itf, b: Itf): number => {
      if (sort.col === 'name') {
        // Natural order (Ethernet2/1 < Ethernet2/10 < Port-Channel2 < Port-Channel10), by device.
        const c = `${a.deviceHostname} ${a.name}`.localeCompare(`${b.deviceHostname} ${b.name}`, undefined, { numeric: true });
        return sort.dir === 'desc' ? -c : c;
      }
      const av = sort.col === 'current' ? a.primaryBps : a.utilisationPercent;
      const bv = sort.col === 'current' ? b.primaryBps : b.utilisationPercent;
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // nulls last
      if (bv === null) return -1;
      return sort.dir === 'desc' ? bv - av : av - bv;
    };
    // Group by DEVICE + Port-Channel — a LAG name is only unique within a device (both edge
    // routers have a Port-Channel7), so members must be keyed per-device.
    const byPo = new Map<string, Itf[]>();
    const tops: Itf[] = [];
    for (const i of interfaces) {
      if (i.memberOf) {
        const k = ifKey(i.deviceId, i.memberOf);
        const arr = byPo.get(k);
        if (arr) arr.push(i);
        else byPo.set(k, [i]);
      } else tops.push(i); // Port-Channels + standalone ports
    }
    tops.sort(cmp);
    const out: { i: Itf; depth: number; children: number; expanded: boolean }[] = [];
    const claimed = new Set<string>();
    for (const t of tops) {
      const key = ifKey(t.deviceId, t.name);
      const members = t.name.startsWith('Port-Channel') ? (byPo.get(key) ?? []).slice().sort(cmp) : [];
      if (members.length) claimed.add(key);
      const expanded = !collapsed[key];
      out.push({ i: t, depth: 0, children: members.length, expanded });
      if (expanded) for (const m of members) out.push({ i: m, depth: 1, children: 0, expanded: false });
    }
    // Members whose Port-Channel isn't in the current view → show at top level (never hidden).
    for (const [k, members] of byPo) if (!claimed.has(k)) for (const m of members.slice().sort(cmp)) out.push({ i: m, depth: 0, children: 0, expanded: false });
    return out;
  }, [interfaces, sort, collapsed]);

  // The delivery view hides only sessions EXPLICITLY classified as non-delivery (route-collector
  // or internal iBGP). Fail open: an absent/unknown role is treated as delivery, so peers never
  // vanish when the API predates the role field.
  const isNonDelivery = (role: string | null | undefined) => role === 'route-collector' || role === 'internal';
  const bgpProviders = useMemo(
    () => [...new Set(t.bgpPeers.filter((p) => !isNonDelivery(p.role)).map((p) => p.provider).filter((x): x is string => !!x))].sort(),
    [t.bgpPeers],
  );
  const bgpPeers = useMemo(
    () =>
      t.bgpPeers.filter((p) => {
        if (isNonDelivery(p.role)) return false; // route-collector / iBGP are not delivery paths
        if (device && p.deviceId !== device) return false; // Router (shared with the rest of the page)
        if (bgpProvider && p.provider !== bgpProvider) return false;
        if (bgpAsn.trim() && !String(p.peerAsn ?? '').includes(bgpAsn.trim())) return false;
        return true;
      }),
    [t.bgpPeers, device, bgpProvider, bgpAsn],
  );
  // Non-delivery sessions excluded from the delivery view (within the current router scope).
  const bgpExcluded = useMemo(() => {
    const scoped = t.bgpPeers.filter((p) => (device ? p.deviceId === device : true) && isNonDelivery(p.role));
    return {
      routeCollector: scoped.filter((p) => p.role === 'route-collector').length,
      internal: scoped.filter((p) => p.role === 'internal').length,
    };
  }, [t.bgpPeers, device]);

  // Group BGP sessions by provider (fallback ASN / peer address) — one operator may hold several
  // sessions (PNI + INEX, across both edge routers); the group summary expands to the sessions.
  const bgpGroups = useMemo(() => {
    const by = new Map<string, typeof bgpPeers>();
    for (const p of bgpPeers) {
      const key = p.provider ?? (p.peerAsn !== null ? `AS${p.peerAsn}` : p.peerAddress);
      const arr = by.get(key);
      if (arr) arr.push(p);
      else by.set(key, [p]);
    }
    return [...by.entries()]
      .map(([key, sessions]) => ({
        key,
        provider: sessions.find((s) => s.provider)?.provider ?? null,
        asn: sessions.find((s) => s.peerAsn !== null)?.peerAsn ?? null,
        types: [...new Set(sessions.map((s) => s.connectionType).filter((x): x is string => !!x))],
        intfs: [...new Set(sessions.map((s) => s.interfaceId).filter((x): x is string => !!x))],
        anyDown: sessions.some((s) => !s.established),
        sessions,
      }))
      .sort((a, b) => (a.provider ?? a.key).localeCompare(b.provider ?? b.key, undefined, { numeric: true }));
  }, [bgpPeers]);

  const stale = t.status !== null && (t.status.lastError !== null || (t.completeness?.level === 'empty' && t.status.enabled) || t.warnings.some((w) => /stale|unavailable/i.test(w)));

  // Per-second ticker for the "next refresh in Ns" countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsToRefresh = t.refreshMs && t.lastLoadedAt !== null ? Math.max(0, Math.ceil((t.lastLoadedAt + t.refreshMs - now) / 1000)) : null;
  // Countdown to the next live read, rendered beside the Interfaces heading so it stays in view
  // while monitoring the table. Its own pill; shown whenever auto-refresh is running.
  const countdownPill = secondsToRefresh !== null && (
    <span className="badge live-countdown" title="Countdown to the next live read from CloudVision (auto-refreshes every 10s)">
      <span className="live-dot" />
      {secondsToRefresh === 0 ? 'reading…' : `next read in ${secondsToRefresh}s`}
    </span>
  );

  return (
    <section className="page">
      <header className="page-head">
        <h1>Network Telemetry</h1>
        <div className="head-meta">
          <span className={`badge ${t.mode === 'cloudvision' ? 'ok' : t.mode === 'mock' ? 'warn' : 'neutral'}`}>
            {t.mode === 'cloudvision' ? 'LIVE · CloudVision' : t.mode === 'mock' ? 'MOCK · SYNTHETIC' : 'NOT CONNECTED'}
          </span>
          {t.status?.snapshotAgeSeconds !== undefined && t.status?.snapshotAgeSeconds !== null && (
            <span className="muted">telemetry {formatFreshness(t.status.snapshotAgeSeconds)}</span>
          )}
        </div>
      </header>

      <nav className="subtabs">
        <button className={`subtab ${tab === 'telemetry' ? 'active' : ''}`} onClick={() => setTab('telemetry')}>Telemetry</button>
        <button className={`subtab ${tab === 'bandwidth' ? 'active' : ''}`} onClick={() => setTab('bandwidth')}>Bandwidth</button>
        <button className={`subtab ${tab === 'resolvers' ? 'active' : ''}`} onClick={() => setTab('resolvers')}>Resolvers</button>
      </nav>

      {tab === 'bandwidth' && <DcBandwidth interfaces={t.interfaces} />}
      {tab === 'resolvers' && <ResolverView />}
      {tab === 'telemetry' && (<>
      {t.notice && t.mode !== 'disabled' && <div className="notice info">{t.notice}</div>}
      {t.mode === 'disabled' && <div className="notice info">Telemetry not connected — the CloudVision connector is disabled. Enable it to see live edge-router state.</div>}
      {t.mode !== 'disabled' && t.status && t.status.edgeDeviceIdCount === 0 && t.status.deviceCount > 0 && (
        <div className="notice info">
          Showing all <b>{t.status.deviceCount}</b> devices CloudVision discovered (routers and switches). To limit this to the
          edge routers, set the <b>edge device IDs</b> in <b>Integrations → CloudVision</b>.
        </div>
      )}
      {stale && <div className="notice warn">Telemetry is stale or degraded — values may not reflect the current network state.</div>}
      {t.error && <div className="notice danger">{t.error}</div>}
      {t.warnings.length > 0 && (
        <div className="notice warn">
          {t.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      {/* Summary */}
      <div className="grid cols-4">
        <div className="card"><div className="muted">Total edge</div><div className="stat">{formatBps(t.summary?.totalEdgeThroughputBps)}</div></div>
        <div className="card">
          <div className="muted">Peering</div>
          <div className="stat">{formatBps(t.summary?.totalPeeringThroughputBps)}</div>
          <CapacityBreakdown links={peeringLinks} totalBps={peeringCapacityBps} />
        </div>
        <div className="card">
          <div className="muted">Transit</div>
          <div className="stat">{formatBps(t.summary?.totalTransitThroughputBps)}</div>
          <CapacityBreakdown links={transitLinks} totalBps={transitCapacityBps} />
        </div>
        <div className="card"><div className="muted">Unhealthy links</div><div className="stat">{num(t.summary?.unhealthyLinks)}</div></div>
        <div className="card"><div className="muted">Unhealthy BGP peers</div><div className="stat">{num(t.summary?.unhealthyBgpPeers)}</div></div>
        <div className="card"><div className="muted">Devices / interfaces</div><div className="stat">{num(t.summary?.deviceCount)} / {num(t.summary?.interfaceCount)}</div></div>
      </div>

      {/* Devices — selectable; click a device to drill into its interfaces + BGP peers */}
      <h2>Devices {t.devices.length > 0 && <span className="muted">({t.devices.length})</span>}</h2>
      {selectedDevice && (
        <div className="notice info">
          Showing <strong>{selectedDevice.hostname}</strong> only.{' '}
          <button className="linklike" onClick={() => setDevice('')}>Show all devices</button>
        </div>
      )}
      <div className="matrix-wrap">
        <table className="matrix selectable">
          <thead>
            <tr><th>Router</th><th>Device ID</th><th>Model</th><th>Software</th><th>Streaming</th><th>Interfaces</th><th>Age</th></tr>
          </thead>
          <tbody>
            {t.devices.length === 0 && <tr><td colSpan={7} className="center-note">No devices.</td></tr>}
            {t.devices.map((d) => {
              const ifCount = t.interfaces.filter((i) => i.deviceId === d.id).length;
              return (
                <tr key={d.id} className={device === d.id ? 'row-selected' : 'row-click'} onClick={() => toggleDevice(d.id)}>
                  <td>{d.hostname}</td>
                  <td className="muted">{d.id}</td>
                  <td>{d.modelName ?? '—'}</td>
                  <td className="muted">{d.softwareVersion ?? '—'}</td>
                  <td><span className={`badge ${d.streaming ? 'ok' : 'neutral'} badge-sm`}>{d.streaming ? 'streaming' : 'not streaming'}</span></td>
                  <td>{ifCount}</td>
                  <td className="muted">{formatFreshness(d.freshness.ageSeconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Busiest links — top 10 interfaces by current bandwidth (live), scoped to the Router filter */}
      <div className="section-head">
        <h2>Top interfaces by bandwidth {selectedDevice && <span className="muted">· {selectedDevice.hostname}</span>}</h2>
        <button className="btn copy-btn" onClick={copyTopInterfaces} title="Copy this table (tab-separated — paste into a spreadsheet)">
          {copiedTop ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr><th>Router</th><th>Interface</th><th>Description</th><th>Provider</th><th>Capacity</th><th>Current</th><th>Util</th></tr>
          </thead>
          <tbody>
            {topInterfaces.length === 0 && <tr><td colSpan={7} className="center-note">No interface utilisation yet.</td></tr>}
            {topInterfaces.map((i) => {
              const key = ifKey(i.deviceId, i.name);
              return (
                <tr key={key}>
                  <td>{i.deviceHostname}</td>
                  <td>{i.name}</td>
                  <td className="muted">{i.description ?? '—'}</td>
                  <td>{i.provider ?? '—'}</td>
                  <td>{formatBps(i.speedBps)}</td>
                  <td>{formatBps(i.primaryBps)}</td>
                  <td className={utilClass(levelByKey.get(key) ?? 'ok')}>{formatPercent(i.utilisationPercent)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Interface table */}
      <div className="section-head">
        <h2>Interfaces {selectedDevice && <span className="muted">· {selectedDevice.hostname}</span>}</h2>
        {countdownPill}
      </div>
      {t.devices.length > 0 && t.interfaces.length === 0 && (
        <div className="notice info">Device inventory is live, but per-interface telemetry is not yet connected for this device set — interface throughput/state will populate once the interface feed is wired.</div>
      )}
      <div className="filters">
        <label className="field"><span>Router</span>
          <select value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">All</option>
            {t.devices.map((d) => <option key={d.id} value={d.id}>{d.hostname}</option>)}
          </select>
        </label>
        <label className="field"><span>Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field"><span>Link type</span>
          <select value={linkType} onChange={(e) => setLinkType(e.target.value)}>
            <option value="">All</option>
            {LINK_TYPES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {HEALTHS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="field"><span>Search</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="interface / description" /></label>
        <label className="field"><span>Order</span>
          <button className="btn" onClick={() => setSort(sort.col === 'name' ? { col: 'current', dir: 'desc' } : { col: 'name', dir: 'asc' })}>
            {sort.col === 'name' ? 'By bandwidth ↓' : 'By name'}
          </button>
        </label>
        <label className="switch" title="Hide interfaces carrying no traffic (0 b/s in and out) — unused ports">
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} /> Hide idle ports (0 b/s)
        </label>
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Router</th>
              <th className="sortable" onClick={() => sortBy('name')}>Interface{arrow('name')}</th>
              <th>Description</th><th>Provider</th><th>Link type</th>
              <th>Capacity</th>
              <th className="sortable" onClick={() => sortBy('current')}>Current{arrow('current')}</th>
              <th className="sortable" onClick={() => sortBy('util')}>Util{arrow('util')}</th>
              <th>Src</th><th>Errors</th><th>Discards</th><th>Status</th><th>Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={13} className="center-note">No interfaces match the current filters.</td></tr>}
            {rows.map(({ i, depth, children, expanded }) => {
              const m = healthMeta(i.status);
              const bw = bandwidthSourceMeta(i.bandwidthSource);
              const oper = operMeta(i.operState);
              const key = ifKey(i.deviceId, i.name);
              return (
                <tr key={key} className={depth ? 'lag-member' : children ? 'lag-parent' : undefined}>
                  <td>{depth ? '' : i.deviceHostname}</td>
                  <td className={depth ? 'itf-member' : undefined}>
                    {children > 0 && (
                      <button className="tree-toggle" onClick={() => toggleCollapse(key)} aria-label={expanded ? 'collapse' : 'expand'}>{expanded ? '▾' : '▸'}</button>
                    )}
                    {depth > 0 && <span className="tree-branch">└─ </span>}
                    {i.name} <span className={`badge ${oper.badge} badge-sm`}>{oper.label}</span>
                    {children > 0 && <span className="muted"> · {children} member{children > 1 ? 's' : ''}</span>}
                  </td>
                  <td className="muted">{i.description ?? '—'}</td>
                  <td>{i.provider ?? '—'}</td>
                  <td>{i.linkType}</td>
                  <td>{formatBps(i.speedBps)}</td>
                  <td>{formatBps(i.primaryBps)}</td>
                  <td className={utilClass(levelByKey.get(key) ?? 'ok')}>{formatPercent(i.utilisationPercent)}</td>
                  <td><span className={`badge ${bw.badge} badge-sm`}>{bw.label}</span></td>
                  <td>{num((i.inErrors ?? 0) + (i.outErrors ?? 0))}</td>
                  <td>{num((i.inDiscards ?? 0) + (i.outDiscards ?? 0))}</td>
                  <td><span className={`badge ${m.badge}`}>{m.label}</span></td>
                  <td className="muted">{formatFreshness(i.freshness.ageSeconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* BGP table */}
      <h2>BGP peers {selectedDevice && <span className="muted">· {selectedDevice.hostname}</span>}</h2>
      <div className="filters">
        <label className="field"><span>Router</span>
          <select value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">All</option>
            {t.devices.map((d) => <option key={d.id} value={d.id}>{d.hostname}</option>)}
          </select>
        </label>
        <label className="field"><span>Provider</span>
          <select value={bgpProvider} onChange={(e) => setBgpProvider(e.target.value)}>
            <option value="">All</option>
            {bgpProviders.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field"><span>ASN</span><input value={bgpAsn} onChange={(e) => setBgpAsn(e.target.value)} placeholder="e.g. 174" inputMode="numeric" /></label>
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr><th></th><th>Provider</th><th>ASN</th><th>Connection</th><th>Sessions</th><th>Interfaces</th><th>State</th></tr>
          </thead>
          <tbody>
            {bgpGroups.length === 0 && <tr><td colSpan={7} className="center-note">No BGP peers.</td></tr>}
            {bgpGroups.map((g) => {
              const open = bgpOpen.has(g.key);
              return (
                <Fragment key={g.key}>
                  <tr className="row-click" onClick={() => toggleBgp(g.key)}>
                    <td><button className="tree-toggle" aria-label={open ? 'collapse' : 'expand'}>{open ? '▾' : '▸'}</button></td>
                    <td><strong>{g.provider ?? '—'}</strong></td>
                    <td>{g.asn !== null ? `AS${g.asn}` : '—'}</td>
                    <td>{g.types.length ? g.types.map((ty) => <span key={ty} className={`badge badge-sm ${connBadge(ty)}`} style={{ marginRight: '0.25rem' }}>{ty}</span>) : <span className="muted">—</span>}</td>
                    <td>{g.sessions.length}</td>
                    <td className="muted">{g.intfs.join(', ') || '—'}</td>
                    <td>{g.anyDown ? <span className="badge danger badge-sm">degraded</span> : <span className="badge ok badge-sm">up</span>}</td>
                  </tr>
                  {open && g.sessions.map((p) => {
                    const m = bgpMeta(p.state);
                    const itf = p.interfaceId ? itfByKey.get(`${p.deviceId}::${p.interfaceId}`) : undefined;
                    return (
                      <tr key={`${p.deviceId}::${p.peerAddress}`} className="bgp-session">
                        <td></td>
                        <td className="muted" colSpan={2}>{p.deviceHostname} · <span className="mono">{p.peerAddress}</span></td>
                        <td>
                          {p.connectionType && <span className={`badge badge-sm ${connBadge(p.connectionType)}`}>{p.connectionType}</span>}
                          {p.interfaceId && <span className="muted"> {p.interfaceId}</span>}
                        </td>
                        <td><span className={`badge ${m.badge} badge-sm`}>{m.label}</span>{p.adminShutdown && <span className="badge warn badge-sm" title="Administratively shut down"> shut</span>}</td>
                        <td className={itf ? utilClass(levelByKey.get(`${p.deviceId}::${itf.name}`) ?? 'ok') : undefined}>
                          {itf ? `${formatBps(itf.primaryBps)} · ${formatPercent(itf.utilisationPercent)}` : '—'}
                        </td>
                        <td className="muted">{formatUptime(p.uptimeSeconds)}{p.addressFamilies.length ? ` · ${p.addressFamilies.join(', ')}` : ''}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(bgpExcluded.routeCollector > 0 || bgpExcluded.internal > 0) && (
        <p className="muted bgp-excluded-note">
          Delivery view only.{' '}
          {[
            bgpExcluded.routeCollector > 0 ? `${bgpExcluded.routeCollector} route-collector` : null,
            bgpExcluded.internal > 0 ? `${bgpExcluded.internal} internal (iBGP)` : null,
          ].filter(Boolean).join(' and ')}{' '}
          {bgpExcluded.routeCollector + bgpExcluded.internal === 1 ? 'session' : 'sessions'} hidden — they carry no audience traffic.
        </p>
      )}
      </>)}
    </section>
  );
}

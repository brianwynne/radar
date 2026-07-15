// Network Telemetry — read-only CloudVision operational view. Summary tiles, time-series
// sparklines, provider cards, a filterable interface table, and a BGP table. Everything is
// informational (RADAR issues no writes); configured facts (capacity, classification) are
// shown distinctly from observed telemetry, and a missing/stale value is shown as such —
// never invented. Auto-refreshes; clearly indicates stale data.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useCloudVision } from '../telemetry/use-cloudvision';
import { Sparkline } from '../telemetry/Sparkline';
import { formatBps, formatPercent, formatFreshness } from '../telemetry/format';
import { healthMeta, bgpMeta, operMeta, bandwidthSourceMeta } from '../telemetry/cv-format';
import type { LinkType, NetworkHealth } from '../api/types';

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
  const [provider, setProvider] = useState('');
  const [linkType, setLinkType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [device, setDevice] = useState(''); // selected device id (drill-down)
  const [hideNoCapacity, setHideNoCapacity] = useState(false); // hide ports with no reported capacity (no optic)
  const [sort, setSort] = useState<{ col: 'name' | 'current' | 'util'; dir: 'asc' | 'desc' }>({ col: 'name', dir: 'asc' });
  const sortBy = (col: 'name' | 'current' | 'util') => setSort((s) => (s.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' ? 'asc' : 'desc' }));
  const arrow = (col: 'name' | 'current' | 'util') => (sort.col === col ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '');
  const { hasPermission } = useAuth();
  const canLabel = hasPermission('mapping.manage');
  // Local overrides for friendly names being edited (survive the auto-refresh).
  const [labelEdits, setLabelEdits] = useState<Record<string, string>>({});
  const [labelSaving, setLabelSaving] = useState<Record<string, boolean>>({});
  const ifKey = (deviceId: string, name: string) => `${deviceId}::${name}`;

  const saveLabel = async (deviceId: string, name: string, value: string) => {
    const key = ifKey(deviceId, name);
    setLabelSaving((s) => ({ ...s, [key]: true }));
    try {
      await api.networkSetInterfaceLabel({ deviceId, name, friendlyName: value });
      t.refresh();
    } catch {
      // leave the typed value in place; the persisted value will reconcile on next refresh
    } finally {
      setLabelSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const selectedDevice = t.devices.find((d) => d.id === device) ?? null;
  const toggleDevice = (id: string) => setDevice((cur) => (cur === id ? '' : id));

  const providers = useMemo(() => [...new Set(t.interfaces.map((i) => i.provider).filter((p): p is string => !!p))].sort(), [t.interfaces]);

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

  const interfaces = useMemo(
    () =>
      t.interfaces.filter((i) => {
        if (device && i.deviceId !== device) return false;
        if (provider && i.provider !== provider) return false;
        if (linkType && i.linkType !== linkType) return false;
        if (status && i.status !== status) return false;
        if (hideNoCapacity && i.speedBps === null) return false; // no capacity ⇒ likely no optic
        if (search) {
          const q = search.toLowerCase();
          if (!`${i.name} ${i.description ?? ''} ${i.deviceHostname}`.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [t.interfaces, device, provider, linkType, status, search, hideNoCapacity],
  );

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

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

  const bgpPeers = useMemo(() => t.bgpPeers.filter((p) => !device || p.deviceId === device), [t.bgpPeers, device]);

  const history = t.history;
  const series = (key: 'totalEdgeThroughputBps' | 'totalPeeringThroughputBps' | 'totalTransitThroughputBps' | 'operationalHeadroomBps') => history.map((h) => h[key]);
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

      {t.notice && t.mode !== 'disabled' && <div className="notice info">{t.notice}</div>}
      {t.mode === 'disabled' && <div className="notice info">Telemetry not connected — the CloudVision connector is disabled. Enable it to see live edge-router state.</div>}
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
        <div className="card"><div className="muted">Peering</div><div className="stat">{formatBps(t.summary?.totalPeeringThroughputBps)}</div></div>
        <div className="card"><div className="muted">Transit</div><div className="stat">{formatBps(t.summary?.totalTransitThroughputBps)}</div></div>
        <div className="card"><div className="muted">Operational headroom</div><div className="stat">{formatBps(t.summary?.operationalHeadroomBps)}</div></div>
        <div className="card"><div className="muted">Operational capacity</div><div className="stat">{formatBps(t.summary?.operationalCapacityBps)}</div></div>
        <div className="card"><div className="muted">Unhealthy links</div><div className="stat">{num(t.summary?.unhealthyLinks)}</div></div>
        <div className="card"><div className="muted">Unhealthy BGP peers</div><div className="stat">{num(t.summary?.unhealthyBgpPeers)}</div></div>
        <div className="card"><div className="muted">Devices / interfaces</div><div className="stat">{num(t.summary?.deviceCount)} / {num(t.summary?.interfaceCount)}</div></div>
      </div>

      {/* Time-series */}
      <h2>Trend</h2>
      <div className="grid cols-4">
        <div className="card"><div className="muted">Total edge</div><Sparkline data={series('totalEdgeThroughputBps')} ariaLabel="total edge throughput trend" /><div className="stat-sm">{formatBps(t.summary?.totalEdgeThroughputBps)}</div></div>
        <div className="card"><div className="muted">Peering</div><Sparkline data={series('totalPeeringThroughputBps')} ariaLabel="peering throughput trend" /><div className="stat-sm">{formatBps(t.summary?.totalPeeringThroughputBps)}</div></div>
        <div className="card"><div className="muted">Transit</div><Sparkline data={series('totalTransitThroughputBps')} ariaLabel="transit throughput trend" /><div className="stat-sm">{formatBps(t.summary?.totalTransitThroughputBps)}</div></div>
        <div className="card"><div className="muted">Headroom</div><Sparkline data={series('operationalHeadroomBps')} ariaLabel="operational headroom trend" /><div className="stat-sm">{formatBps(t.summary?.operationalHeadroomBps)}</div></div>
      </div>

      {/* Provider cards */}
      <h2>Providers</h2>
      <div className="grid cols-3">
        {t.linkGroups.length === 0 && <div className="center-note">No provider groups.</div>}
        {t.linkGroups.map((g) => {
          const m = healthMeta(g.status);
          return (
            <div className="card" key={g.key}>
              <div className="card-head">
                <strong>{g.label}</strong>
                <span className={`badge ${m.badge}`}>{m.label}</span>
              </div>
              <div className="kv"><span>Current</span><span>{formatBps(g.currentBps)}</span></div>
              <div className="kv"><span>Capacity</span><span>{formatBps(g.capacityBps)}</span></div>
              <div className="kv"><span>Utilisation</span><span>{formatPercent(g.utilisationPercent)}</span></div>
              <div className="kv"><span>Headroom</span><span>{formatBps(g.headroomBps)}</span></div>
              <div className="kv"><span>Healthy links</span><span>{g.healthyLinks}/{g.totalLinks}</span></div>
            </div>
          );
        })}
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

      {/* Interface table */}
      <div className="section-head">
        <h2>Interfaces {selectedDevice && <span className="muted">· {selectedDevice.hostname}</span>}</h2>
        {countdownPill}
      </div>
      {t.devices.length > 0 && t.interfaces.length === 0 && (
        <div className="notice info">Device inventory is live, but per-interface telemetry is not yet connected for this device set — interface throughput/state will populate once the interface feed is wired.</div>
      )}
      <div className="filters">
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
        <label className="switch" title="Hide interfaces with no reported capacity — usually empty ports with no optic installed">
          <input type="checkbox" checked={hideNoCapacity} onChange={(e) => setHideNoCapacity(e.target.checked)} /> Hide ports without capacity
        </label>
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Router</th>
              <th className="sortable" onClick={() => sortBy('name')}>Interface{arrow('name')}</th>
              <th>Name</th><th>Description</th><th>Provider</th><th>Link type</th>
              <th>Capacity</th>
              <th className="sortable" onClick={() => sortBy('current')}>Current{arrow('current')}</th>
              <th className="sortable" onClick={() => sortBy('util')}>Util{arrow('util')}</th>
              <th>Src</th><th>Errors</th><th>Discards</th><th>Status</th><th>Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={14} className="center-note">No interfaces match the current filters.</td></tr>}
            {rows.map(({ i, depth, children, expanded }) => {
              const m = healthMeta(i.status);
              const bw = bandwidthSourceMeta(i.bandwidthSource);
              const oper = operMeta(i.operState);
              const key = ifKey(i.deviceId, i.name);
              const labelValue = labelEdits[key] ?? i.friendlyName ?? '';
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
                  <td>
                    {canLabel ? (
                      <input
                        className="label-input"
                        value={labelValue}
                        placeholder="add name"
                        disabled={labelSaving[key]}
                        onChange={(e) => setLabelEdits((s) => ({ ...s, [key]: e.target.value }))}
                        onBlur={() => { if ((labelEdits[key] ?? i.friendlyName ?? '') !== (i.friendlyName ?? '')) void saveLabel(i.deviceId, i.name, labelValue); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                    ) : (
                      <span>{i.friendlyName ?? '—'}</span>
                    )}
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
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr><th>Router</th><th>Provider</th><th>Peer</th><th>ASN</th><th>State</th><th>Uptime</th><th>Received</th><th>Advertised</th></tr>
          </thead>
          <tbody>
            {bgpPeers.length === 0 && <tr><td colSpan={8} className="center-note">No BGP peers.</td></tr>}
            {bgpPeers.map((p) => {
              const m = bgpMeta(p.state);
              return (
                <tr key={`${p.deviceId}::${p.peerAddress}`}>
                  <td>{p.deviceHostname}</td>
                  <td>{p.provider ?? '—'}</td>
                  <td>{p.peerAddress}</td>
                  <td>{p.peerAsn ?? '—'}</td>
                  <td><span className={`badge ${m.badge}`}>{m.label}</span></td>
                  <td>{formatUptime(p.uptimeSeconds)}</td>
                  <td>{num(p.prefixesReceived)}</td>
                  <td>{num(p.prefixesAdvertised)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

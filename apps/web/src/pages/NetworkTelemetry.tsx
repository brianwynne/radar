// Network Telemetry — read-only CloudVision operational view. Summary tiles, time-series
// sparklines, provider cards, a filterable interface table, and a BGP table. Everything is
// informational (RADAR issues no writes); configured facts (capacity, classification) are
// shown distinctly from observed telemetry, and a missing/stale value is shown as such —
// never invented. Auto-refreshes; clearly indicates stale data.
import { useMemo, useState } from 'react';
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

export function NetworkTelemetry() {
  const t = useCloudVision(10_000);
  const [provider, setProvider] = useState('');
  const [linkType, setLinkType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [device, setDevice] = useState(''); // selected device id (drill-down)

  const selectedDevice = t.devices.find((d) => d.id === device) ?? null;
  const toggleDevice = (id: string) => setDevice((cur) => (cur === id ? '' : id));

  const providers = useMemo(() => [...new Set(t.interfaces.map((i) => i.provider).filter((p): p is string => !!p))].sort(), [t.interfaces]);

  const interfaces = useMemo(
    () =>
      t.interfaces.filter((i) => {
        if (device && i.deviceId !== device) return false;
        if (provider && i.provider !== provider) return false;
        if (linkType && i.linkType !== linkType) return false;
        if (status && i.status !== status) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!`${i.name} ${i.description ?? ''} ${i.deviceHostname}`.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [t.interfaces, device, provider, linkType, status, search],
  );

  const bgpPeers = useMemo(() => t.bgpPeers.filter((p) => !device || p.deviceId === device), [t.bgpPeers, device]);

  const history = t.history;
  const series = (key: 'totalEdgeThroughputBps' | 'totalPeeringThroughputBps' | 'totalTransitThroughputBps' | 'operationalHeadroomBps') => history.map((h) => h[key]);
  const stale = t.status !== null && (t.status.lastError !== null || (t.completeness?.level === 'empty' && t.status.enabled) || t.warnings.some((w) => /stale|unavailable/i.test(w)));

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
      <h2>Interfaces {selectedDevice && <span className="muted">· {selectedDevice.hostname}</span>}</h2>
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
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Router</th><th>Interface</th><th>Description</th><th>Provider</th><th>Link type</th>
              <th>Capacity</th><th>Current</th><th>Util</th><th>Src</th><th>Errors</th><th>Discards</th><th>Status</th><th>Age</th>
            </tr>
          </thead>
          <tbody>
            {interfaces.length === 0 && <tr><td colSpan={13} className="center-note">No interfaces match the current filters.</td></tr>}
            {interfaces.map((i) => {
              const m = healthMeta(i.status);
              const bw = bandwidthSourceMeta(i.bandwidthSource);
              const oper = operMeta(i.operState);
              return (
                <tr key={`${i.deviceId}::${i.name}`}>
                  <td>{i.deviceHostname}</td>
                  <td>{i.name} <span className={`badge ${oper.badge} badge-sm`}>{oper.label}</span></td>
                  <td className="muted">{i.description ?? '—'}</td>
                  <td>{i.provider ?? '—'}</td>
                  <td>{i.linkType}</td>
                  <td>{formatBps(i.speedBps)}</td>
                  <td>{formatBps(i.primaryBps)}</td>
                  <td>{formatPercent(i.utilisationPercent)}</td>
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

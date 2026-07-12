// Presentational, read-only cache-pool / cache-node / origin telemetry. Renders CONFIGURED
// capacity/node-count distinctly from OBSERVED throughput/CPU/hit-ratio, computes nothing
// (headroom comes from the API), and is honest about disabled/stale/unavailable data.
// `detail` reveals thresholds/warnings, gated on ns1.detail.read.
import type { CacheNodeSample, CachePoolSample, OriginSample } from '../api/types';
import { formatBps, formatFreshness, formatPercent, formatRatio, statusMeta, worstStatus } from './format';

const headroomText = (bps: number | null) => (bps === null ? 'n/a' : formatBps(bps));

export function CachePoolTable({ pools, detail }: { pools: CachePoolSample[]; detail?: boolean }) {
  if (pools.length === 0) return <div className="muted">No configured cache pools.</div>;
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th>Pool</th><th>Site</th><th>Status</th><th>Throughput</th><th>CPU</th><th>Hit ratio</th>
            <th>Capacity</th><th>Headroom</th><th>Nodes</th><th>Freshness</th>
            {detail && <th>Warn/Crit</th>}
          </tr>
        </thead>
        <tbody>
          {pools.map((p) => (
            <tr key={p.poolId}>
              <td>{p.poolName}</td>
              <td className="muted">{p.site}</td>
              <td><span className={`badge ${statusMeta(p.status).badge}`}>{statusMeta(p.status).label}</span></td>
              <td className="mono">{formatPercent(p.observedUtilisationPercent)} · {formatBps(p.observedOutboundBps)}</td>
              <td className="mono">{formatPercent(p.cpuUtilisationPercent)}</td>
              <td className="mono">{formatRatio(p.cacheHitRatio)}</td>
              <td className="mono">{formatBps(p.configuredCapacityBps)}</td>
              <td className="mono">{headroomText(p.headroomBps)}</td>
              <td className="mono">{p.cacheNodeCount}</td>
              <td className="muted">{formatFreshness(p.freshness.ageSeconds)}</td>
              {detail && <td className="mono muted">{p.warningPercent ?? '—'}/{p.criticalPercent ?? '—'}%</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CacheNodeTable({ nodes, detail }: { nodes: CacheNodeSample[]; detail?: boolean }) {
  if (nodes.length === 0) return <div className="muted">No configured cache nodes.</div>;
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr><th>Node</th><th>Pool</th><th>Status</th><th>Throughput</th><th>CPU</th><th>Capacity</th><th>Headroom</th><th>Freshness</th>{detail && <th>Warn/Crit</th>}</tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.nodeId}>
              <td>{n.nodeName}</td>
              <td className="muted">{n.poolId}</td>
              <td><span className={`badge ${statusMeta(n.status).badge}`}>{statusMeta(n.status).label}</span></td>
              <td className="mono">{formatPercent(n.observedUtilisationPercent)} · {formatBps(n.observedOutboundBps)}</td>
              <td className="mono">{formatPercent(n.cpuUtilisationPercent)}</td>
              <td className="mono">{formatBps(n.configuredCapacityBps)}</td>
              <td className="mono">{headroomText(n.headroomBps)}</td>
              <td className="muted">{formatFreshness(n.freshness.ageSeconds)}</td>
              {detail && <td className="mono muted">{n.warningPercent ?? '—'}/{n.criticalPercent ?? '—'}%</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OriginPanel({ origin }: { origin: OriginSample | null }) {
  if (!origin) return <div className="muted">Origin telemetry unavailable.</div>;
  const meta = statusMeta(origin.status);
  return (
    <div className="kv">
      <span>
        {origin.originName} <span className={`badge ${meta.badge}`}>{meta.label}</span>
      </span>
      <span className="muted">
        CPU {formatPercent(origin.cpuUtilisationPercent)} · requests {origin.requestRate ?? '—'}/s · bandwidth {formatBps(origin.outboundBandwidthBps)} · {formatFreshness(origin.freshness.ageSeconds)}
      </span>
    </div>
  );
}

/** Compact Réalta delivery context for a Live Steering ISP card: aggregate pool health +
 *  origin, with the explicit responsibility boundary. */
export function RealtaDeliveryContext({ pools, origin }: { pools: CachePoolSample[]; origin: OriginSample | null }) {
  const overall = worstStatus(pools.map((p) => p.status));
  const capacity = pools.reduce((sum, p) => sum + p.configuredCapacityBps, 0);
  const headrooms = pools.map((p) => p.headroomBps);
  const aggregateHeadroom: number | null = headrooms.some((h) => h === null) ? null : headrooms.reduce((sum: number, h) => sum + (h ?? 0), 0);
  const meta = statusMeta(overall);
  return (
    <div className="realta-context">
      <div className="tele-row">
        <span className="seg-label">Réalta pools</span>
        {pools.length} pool{pools.length === 1 ? '' : 's'} · worst <span className={`badge ${meta.badge}`}>{meta.label}</span> · capacity {formatBps(capacity)} · headroom {aggregateHeadroom === null ? 'n/a' : formatBps(aggregateHeadroom)}
      </div>
      <div className="tele-row">
        <span className="seg-label">Origin</span>
        {origin ? <span className={`badge ${statusMeta(origin.status).badge}`}>{statusMeta(origin.status).label}</span> : <span className="muted">unavailable</span>}
        {origin && <span className="muted" style={{ fontSize: '0.74rem' }}> CPU {formatPercent(origin.cpuUtilisationPercent)}</span>}
      </div>
      <div className="tele-row muted" style={{ fontSize: '0.72rem' }}>
        NS1 selects Réalta · Cloudflare selects the pool · RADAR observes pool &amp; origin telemetry (does not control Cloudflare or NS1).
      </div>
    </div>
  );
}

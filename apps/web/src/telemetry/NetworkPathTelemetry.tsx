// Presentational, read-only network-path telemetry. Renders CONFIGURED capacity/target
// distinctly from OBSERVED utilisation, and is honest about disabled/stale/unavailable
// data (never invents a number). `detail` reveals the engineering fields (interface
// mapping, thresholds, warnings) gated on ns1.detail.read.
import type { NetworkPathSample } from '../api/types';
import { formatBps, formatFreshness, formatPercent, hasFreshValue, statusMeta } from './format';

export function PathStatusBadge({ sample }: { sample: NetworkPathSample }) {
  const meta = statusMeta(sample.status);
  return <span className={`badge ${meta.badge}`}>{meta.label}</span>;
}

/** Observed utilisation as an explicit value, or an honest placeholder for
 *  disabled/stale/unavailable telemetry. */
export function ObservedUtilisation({ sample }: { sample: NetworkPathSample }) {
  if (sample.status === 'telemetry_not_connected') return <span className="muted">Telemetry not connected</span>;
  if (sample.status === 'unavailable') return <span className="muted">Unavailable</span>;
  const value = `${formatPercent(sample.observedUtilisationPercent)} · ${formatBps(sample.observedOutboundBps)} out`;
  if (sample.status === 'stale') {
    return (
      <span>
        {value} <span className="badge warn">STALE</span>
      </span>
    );
  }
  return <span>{value}</span>;
}

/** Compact inline telemetry for a single path (used on the Live Steering card). */
export function PathTelemetryInline({ sample, detail }: { sample: NetworkPathSample; detail?: boolean }) {
  const fresh = hasFreshValue(sample.status);
  return (
    <div className="path-telemetry">
      <div className="tele-row">
        <span className="seg-label">Utilisation</span>
        <ObservedUtilisation sample={sample} /> <PathStatusBadge sample={sample} />
      </div>
      <div className="tele-row muted" style={{ fontSize: '0.74rem' }}>
        Configured capacity {formatBps(sample.configuredCapacityBps)} · target {sample.configuredTargetPercent}%
        {(fresh || sample.status === 'stale') && ` · ${formatFreshness(sample.freshness.ageSeconds)}`} · source {sample.source}
      </div>
      {detail && (
        <div className="tele-row muted" style={{ fontSize: '0.72rem' }}>
          interface {sample.interfaceIdentity ?? '—'} · warn {sample.warningThresholdPercent ?? '—'}% / crit {sample.criticalThresholdPercent ?? '—'}%
          {sample.warnings && sample.warnings.length > 0 && ` · ${sample.warnings.join('; ')}`}
        </div>
      )}
    </div>
  );
}

/** A row per path for the Dashboard / Topology panels. */
export function NetworkPathRow({ sample, detail }: { sample: NetworkPathSample; detail?: boolean }) {
  return (
    <tr>
      <td>
        {sample.pathName} <span className="mono muted">{sample.pathType}</span>
      </td>
      <td><PathStatusBadge sample={sample} /></td>
      <td><ObservedUtilisation sample={sample} /></td>
      <td className="mono">{formatBps(sample.configuredCapacityBps)}</td>
      <td className="mono">{sample.configuredTargetPercent}%</td>
      <td className="muted">{formatFreshness(sample.freshness.ageSeconds)}</td>
      {detail && (
        <>
          <td className="mono muted">{sample.interfaceIdentity ?? '—'}</td>
          <td className="mono muted">{sample.warningThresholdPercent ?? '—'}/{sample.criticalThresholdPercent ?? '—'}%</td>
          <td className="muted">{sample.source}</td>
        </>
      )}
    </tr>
  );
}

/** Self-contained telemetry table for the Dashboard and Delivery Topology. */
export function NetworkPathTelemetryTable({ paths, detail }: { paths: NetworkPathSample[]; detail?: boolean }) {
  if (paths.length === 0) return <div className="muted">No configured network paths.</div>;
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th>Path</th>
            <th>Status</th>
            <th>Observed utilisation</th>
            <th>Capacity</th>
            <th>Target</th>
            <th>Freshness</th>
            {detail && (
              <>
                <th>Interface</th>
                <th>Warn/Crit</th>
                <th>Source</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {paths.map((p) => (
            <NetworkPathRow key={p.pathId} sample={p} detail={detail} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Touchstream delivery matrix: channel × format rows against CDN columns, with per-probe drill-down.
//
// Three things drive every design decision here, all of them properties of the real data:
//
//  1. AN EMPTY CELL IS NOT A HEALTHY CELL. Coverage is partial (RTE 1 HLS has no Fastly monitor at
//     all), so "not monitored" gets its own hatched treatment and is never left to read as a pass.
//
//  2. SPEED IS ONLY COMPARABLE FROM THE SAME PLACE. Some CDNs in a row are probed from Dublin and
//     others from Paris/Frankfurt, so their headline averages measure geography as much as CDN. The
//     BASIS TOGGLE is this page's signature control: switch to "like-for-like" and every figure
//     re-bases onto the probe locations the whole row shares, with the excluded ones named. It turns
//     RADAR's honesty rule into a working comparison instead of a disclaimer.
//
//  3. A CDN LABEL IS A CLAIM. Where the observed edge IP contradicts the label, the cell is flagged
//     and the drill-down shows the edge that actually served.
//
// Inline SVG only — RADAR ships no charting library and keeps it that way.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Donut } from '../components/Donut';
import { colorFor } from '../steering/platforms';
import type { TsCell, TsDeliveryResponse, TsMonitor, TsRow, TsSnapshot, TsVantage } from '../api/types';

const REFRESH_MS = 30_000;

/** Speed basis. `headline` is what Touchstream reports per monitor (mixed geography where probe sets
 *  differ); `shared` restricts to the probe locations every CDN in the row has. */
type Basis = 'headline' | 'shared';

const speedOf = (cell: TsCell, basis: Basis): number | null =>
  basis === 'shared' ? cell.sharedSpeed : (cell.monitor?.avgSpeed ?? null);

const fmtSpeed = (v: number | null): string => (v === null ? '—' : v.toFixed(v < 10 ? 1 : 0));

const fmtAge = (seconds: number | null): string => {
  if (seconds === null) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
};

/** Discrete status ribbon from Touchstream's rolling window — one block per sample, oldest left. A
 *  line chart would imply a continuum; these are pass/fail checks, so they stay as blocks. */
function StatusRibbon({ history, color }: { history: number[]; color: string }) {
  if (history.length === 0) return <span className="muted ts-nodata">no history</span>;
  const w = 6;
  const gap = 1.5;
  const h = 14;
  return (
    <svg
      className="ts-ribbon"
      width={history.length * (w + gap)}
      height={h}
      viewBox={`0 0 ${history.length * (w + gap)} ${h}`}
      role="img"
      aria-label={`${history.filter((v) => v === 1).length} of ${history.length} recent checks passed`}
    >
      {history.map((v, i) => (
        <rect
          key={i}
          x={i * (w + gap)}
          y={v === 1 ? 0 : 0}
          width={w}
          height={h}
          rx={1}
          fill={v === 1 ? color : 'var(--danger)'}
          opacity={v === 1 ? 0.85 : 1}
        />
      ))}
    </svg>
  );
}

/** Relative speed bar — scaled to the row's slowest figure so the eye lands on the outlier without
 *  having to read numbers. Lower is better, so a longer bar is worse. */
function SpeedBar({ value, rowMax, color }: { value: number | null; rowMax: number; color: string }) {
  if (value === null) return null;
  const frac = rowMax > 0 ? Math.min(1, value / rowMax) : 0;
  return (
    <svg className="ts-speedbar" width="100%" height="4" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="1" width="100" height="2" rx="1" fill="var(--line)" />
      <rect x="0" y="0" width={Math.max(1.5, frac * 100)} height="4" rx="1" fill={color} opacity={0.75} />
    </svg>
  );
}

/** Per-rendition strip: one block per ABR rendition checked in a probe. Dense on purpose — 14
 *  renditions per stream is a lot of detail that only matters when something is wrong. */
function RenditionStrip({ vantage }: { vantage: TsVantage }) {
  if (vantage.renditions.length === 0) return <span className="muted">no rendition detail</span>;
  return (
    <div className="ts-rends">
      {vantage.renditions.map((r) => (
        <span
          key={`${r.sequence}-${r.name}`}
          className={`ts-rend${r.ok ? '' : ' bad'}${r.stalled ? ' stalled' : ''}`}
          title={[
            r.label ? `${r.name} · ${r.label}` : r.name,
            r.resolution ? r.resolution : null,
            r.httpStatus ? `HTTP ${r.httpStatus}` : null,
            r.statusText,
            r.speed !== null ? `speed ${r.speed}` : null,
            r.stalled ? 'STALLED BITRATE' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {r.label ?? r.name}
        </span>
      ))}
    </div>
  );
}

function VantageTable({ monitor, shared }: { monitor: TsMonitor; shared: string[] }) {
  return (
    <div className="ts-vantages">
      {monitor.vantages.map((v) => {
        const inShared = shared.includes(v.location);
        return (
          <div key={v.location} className={`ts-vantage${inShared ? '' : ' unshared'}`}>
            <div className="ts-vantage-head">
              <span className={`ts-dot ${v.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
              <span className="ts-loc mono">{v.location}</span>
              <span className="muted">
                {[v.region, v.country].filter(Boolean).join(', ') || 'location unknown'}
                {v.supplier ? ` · ${v.supplier}` : ''}
              </span>
              {!inShared && shared.length > 0 && (
                <span className="badge badge-sm" title="Not probed by every CDN in this row, so it cannot be used for a like-for-like comparison">
                  not shared
                </span>
              )}
            </div>
            <div className="ts-vantage-meta">
              <span>
                edge <code>{v.edgeIp ?? 'unknown'}</code>
                {v.edgeIsRteOwned === true && (
                  <span className="badge ok badge-sm" title="This edge IP is inside an RTÉ-owned prefix">
                    RTÉ-owned
                  </span>
                )}
              </span>
              <span className="muted">
                from <code>{v.popIp ?? 'unknown'}</code>
              </span>
              <span className="muted">speed {v.avgSpeed ?? '—'}</span>
            </div>
            <RenditionStrip vantage={v} />
          </div>
        );
      })}
    </div>
  );
}

function CellBody({ cell, basis, rowMax, shared }: { cell: TsCell; basis: Basis; rowMax: number; shared: string[] }) {
  const m = cell.monitor;
  if (!m) {
    // Deliberately loud: absence of measurement is a finding, not a blank.
    return (
      <div className="ts-cell empty" title="No Touchstream monitor exists for this channel, format and CDN — its delivery is unmeasured, not known good">
        <span className="ts-empty-label">not monitored</span>
      </div>
    );
  }
  const color = colorFor(cell.platform === 'Unknown' || cell.platform === 'Triton' ? '' : cell.platform);
  const speed = speedOf(cell, basis);
  const mislabelled = m.warnings.find((w) => w.kind === 'attribution_mismatch' || w.kind === 'attribution_split');
  const unavailable = basis === 'shared' && speed === null;
  return (
    <div className={`ts-cell${m.ok ? '' : ' failing'}${m.plannedOutage ? ' outage' : ''}`}>
      <div className="ts-cell-top">
        <span className={`ts-dot ${m.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span className="ts-cdn mono" title={`Touchstream CDN label: ${m.cdnLabel}`}>
          {m.cdnLabel}
        </span>
        {mislabelled && (
          <span className="badge warn badge-sm" title={mislabelled.message}>
            {mislabelled.kind === 'attribution_split' ? 'label ≠ some edges' : 'label ≠ edge'}
          </span>
        )}
        {m.plannedOutage && (
          <span className="badge badge-sm" title="A planned outage covers this monitor — a failure here is not a fault">
            planned
          </span>
        )}
      </div>
      <StatusRibbon history={m.history} color={m.ok ? color : 'var(--danger)'} />
      <div className="ts-cell-speed">
        <span className="ts-speed mono">{unavailable ? 'n/a' : fmtSpeed(speed)}</span>
        <span className="muted ts-speed-note">
          {basis === 'shared'
            ? unavailable
              ? 'no shared probe'
              : `at ${cell.sharedLocationCount} shared`
            : `${m.vantages.length} probe${m.vantages.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <SpeedBar value={unavailable ? null : speed} rowMax={rowMax} color={color} />
      {basis === 'shared' && cell.unsharedLocations.length > 0 && (
        <div className="ts-cell-excluded muted" title={`Excluded from the like-for-like figure: ${cell.unsharedLocations.join(', ')}`}>
          −{cell.unsharedLocations.length} excluded
        </div>
      )}
      <VantageTable monitor={m} shared={shared} />
    </div>
  );
}

function Row({ row, basis, expanded, onToggle }: { row: TsRow; basis: Basis; expanded: boolean; onToggle: () => void }) {
  const shared = row.comparability.sharedLocations;
  const rowMax = useMemo(() => {
    const values = row.cells.map((c) => speedOf(c, basis)).filter((n): n is number => n !== null);
    return values.length > 0 ? Math.max(...values) : 0;
  }, [row, basis]);
  const monitored = row.cells.filter((c) => c.monitor).length;
  const failing = row.cells.filter((c) => c.monitor && !c.monitor.ok && !c.monitor.plannedOutage).length;

  return (
    <div className={`ts-row${expanded ? ' open' : ''}`}>
      <button className="ts-rowhead" onClick={onToggle} aria-expanded={expanded}>
        <span className="ts-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="ts-channel">{row.channel}</span>
        <span className="badge badge-sm ts-format">{row.format}</span>
        <span className="muted ts-rowmeta">
          {monitored}/{row.cells.length} CDNs monitored
          {failing > 0 ? ` · ${failing} failing` : ''}
        </span>
        {!row.comparability.headlineComparable && (
          <span
            className={`badge ${row.comparability.comparable ? 'warn' : 'danger'} badge-sm`}
            title={row.comparability.reason ?? undefined}
          >
            {row.comparability.comparable ? `compare at ${shared.join('/')}` : 'not comparable'}
          </span>
        )}
      </button>
      <div className="ts-cells" style={{ gridTemplateColumns: `repeat(${row.cells.length}, minmax(0, 1fr))` }}>
        {row.cells.map((c) => (
          <CellBody key={c.platform} cell={c} basis={basis} rowMax={rowMax} shared={shared} />
        ))}
      </div>
      {expanded && row.comparability.reason && (
        <p className="ts-row-note">{row.comparability.reason}</p>
      )}
    </div>
  );
}

function SummaryStrip({ snapshot }: { snapshot: TsSnapshot }) {
  const s = snapshot.summary;
  const coverage = [
    { label: 'monitored', value: s.monitoredCells, color: 'var(--brand)' },
    { label: 'unmonitored', value: Math.max(0, s.possibleCells - s.monitoredCells), color: 'var(--line)' },
  ];
  return (
    <div className="ts-summary">
      <div className="ts-kpi ts-kpi-donut">
        <Donut data={coverage} size={72} ariaLabel="monitor coverage" />
        <div>
          <div className="ts-kpi-value">{s.coveragePercent}%</div>
          <div className="ts-kpi-label">
            coverage
            <span className="muted"> · {s.monitoredCells} of {s.possibleCells} channel×CDN cells</span>
          </div>
        </div>
      </div>
      <div className="ts-kpi">
        <div className={`ts-kpi-value${s.failingCount > 0 ? ' bad' : ' ok'}`}>
          {s.okCount}/{s.monitorCount}
        </div>
        <div className="ts-kpi-label">
          monitors passing
          {s.plannedOutageCount > 0 && <span className="muted"> · {s.plannedOutageCount} planned</span>}
        </div>
      </div>
      <div className="ts-kpi">
        <div className="ts-kpi-value">{s.vantageCount}</div>
        <div className="ts-kpi-label">probe locations</div>
      </div>
      <div className={`ts-kpi${s.attributionMismatchCount + s.attributionSplitCount > 0 ? ' flagged' : ''}`}>
        <div className={`ts-kpi-value${s.attributionMismatchCount + s.attributionSplitCount > 0 ? ' warn' : ''}`}>
          {s.attributionMismatchCount + s.attributionSplitCount}
        </div>
        <div className="ts-kpi-label">
          CDN labels contradicted by the served edge
          {s.attributionSplitCount > 0 && <span className="muted"> · {s.attributionSplitCount} partly</span>}
        </div>
      </div>
      <div className={`ts-kpi${s.incomparableRowCount > 0 ? ' flagged' : ''}`}>
        <div className={`ts-kpi-value${s.incomparableRowCount > 0 ? ' warn' : ''}`}>{s.incomparableRowCount}</div>
        <div className="ts-kpi-label">rows with no like-for-like comparison</div>
      </div>
    </div>
  );
}

export function TouchstreamDelivery() {
  const [data, setData] = useState<TsDeliveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [basis, setBasis] = useState<Basis>('headline');
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .tsDelivery()
        .then((res) => {
          if (!active) return;
          setData(res);
          setError(null);
          setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setError('Could not load Touchstream delivery monitoring.');
          setLoading(false);
        });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const snapshot = data?.snapshot ?? null;
  const platforms = snapshot?.platforms ?? [];
  const anyMixedBasis = snapshot?.rows.some((r) => !r.comparability.headlineComparable) ?? false;

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (loading) return <p className="muted">Loading Touchstream delivery monitoring…</p>;
  if (error) return <div className="notice warn">{error}</div>;

  if (!snapshot) {
    return (
      <div className="notice info">
        <strong>No Touchstream delivery data.</strong>{' '}
        {data?.reason === 'connector disabled'
          ? 'The connector is switched off. Set TOUCHSTREAM_ENABLED=true, then supply the endpoint plus BOTH credentials (the X-TS-ID app id and the bearer token) — either alone is refused.'
          : 'The connector has not captured a snapshot yet.'}
        {data?.lastError && <div className="mono ts-lasterror">{data.lastError}</div>}
      </div>
    );
  }

  return (
    <section className="ts-page">
      <header className="ts-head">
        <div>
          <h3 className="ts-title">Delivery matrix</h3>
          <p className="ts-sub muted">
            Every monitored channel against every CDN, as measured by Touchstream from{' '}
            {snapshot.summary.vantageCount} cloud probe locations.
          </p>
        </div>
        <div className="ts-head-meta">
          <span className={`badge ${snapshot.source === 'live' ? 'ok' : ''} badge-sm`}>
            {snapshot.source === 'live' ? 'LIVE' : 'MOCK'}
          </span>
          <span className="muted">sampled {fmtAge(snapshot.summary.oldestSampleAgeSeconds)}</span>
        </div>
      </header>

      {/* The provenance rule, stated on the page and not only in the API envelope. */}
      <p className="ts-provenance">
        Touchstream probes from cloud and datacentre locations, so this is <strong>measured synthetic delivery</strong> — it
        is not viewer traffic, and it cannot show what a subscriber on any ISP received.
      </p>

      <SummaryStrip snapshot={snapshot} />

      {snapshot.warnings.length > 0 && (
        <div className="notice warn ts-warnings">
          <strong>
            {snapshot.warnings.length} thing{snapshot.warnings.length === 1 ? '' : 's'} to look at
          </strong>
          <ul>
            {snapshot.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="ts-controls">
        <div className="ts-basis" role="group" aria-label="Speed basis">
          <span className="muted ts-basis-label">Speed basis</span>
          <button className={`subtab ${basis === 'headline' ? 'active' : ''}`} onClick={() => setBasis('headline')}>
            Headline
          </button>
          <button className={`subtab ${basis === 'shared' ? 'active' : ''}`} onClick={() => setBasis('shared')}>
            Like-for-like
          </button>
        </div>
        <p className="muted ts-basis-help">
          {basis === 'headline'
            ? anyMixedBasis
              ? 'Averages as Touchstream reports them. Where a row’s CDNs are probed from different places these figures are not comparable — switch to like-for-like.'
              : 'Averages as Touchstream reports them. Every row’s CDNs share the same probe locations, so these are already comparable.'
            : 'Averages restricted to the probe locations every CDN in a row shares, so the comparison isolates the CDN rather than geography.'}
        </p>
      </div>

      <div className="ts-matrix">
        <div className="ts-colhead" style={{ gridTemplateColumns: `repeat(${platforms.length}, minmax(0, 1fr))` }}>
          {platforms.map((p) => (
            <div key={p} className="ts-col">
              <span className="ts-swatch" style={{ background: colorFor(p === 'Unknown' || p === 'Triton' ? '' : p) }} aria-hidden="true" />
              {p}
            </div>
          ))}
        </div>
        {snapshot.rows.map((row) => {
          const key = `${row.channel}·${row.format}`;
          return <Row key={key} row={row} basis={basis} expanded={open.has(key)} onToggle={() => toggle(key)} />;
        })}
      </div>
    </section>
  );
}

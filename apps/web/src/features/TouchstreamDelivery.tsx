// Touchstream delivery matrix — a true matrix: ONE grid, so a CDN column is a scannable vertical
// unit and every cell lines up across every channel. (The first cut made each row its own card, which
// broke column alignment and reduced the "matrix" to a stack of cards.)
//
// Structure, in order of importance:
//   * a dark instrument header, echoing RADAR's chrome, carrying the health read-outs and the one
//     control that changes what the numbers MEAN (the speed basis);
//   * a per-CDN column rail — each column's aggregate across all channels, so columns read as units;
//   * VIDEO and AUDIO groups, split on Touchstream's own product label;
//   * per-row detail that opens INSIDE the grid columns, so probe detail stays column-aligned and
//     therefore comparable across CDNs.
//
// Three properties of the real data drive the semantics:
//   1. AN EMPTY CELL IS NOT A HEALTHY CELL — coverage is genuinely partial, so absence is hatched and
//      labelled, never blank.
//   2. SPEED IS ONLY COMPARABLE FROM THE SAME PLACE — the basis toggle re-bases every figure onto the
//      probe locations a row's CDNs share.
//   3. A CDN LABEL IS A CLAIM — where the observed edge contradicts it, the cell says so.
//
// Inline SVG only; RADAR ships no charting library.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { colorFor } from '../steering/platforms';
import type { TsCell, TsDeliveryResponse, TsGroup, TsMonitor, TsPlatform, TsRow, TsSnapshot, TsVantage } from '../api/types';

const REFRESH_MS = 30_000;

type Basis = 'headline' | 'shared';

const speedOf = (cell: TsCell, basis: Basis): number | null =>
  basis === 'shared' ? cell.sharedSpeed : (cell.monitor?.avgSpeed ?? null);

const fmtSpeed = (v: number | null): string => (v === null ? '—' : v < 10 ? v.toFixed(1) : String(Math.round(v)));

const fmtAge = (seconds: number | null): string => {
  if (seconds === null) return 'age unknown';
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
};

/** Platform tint, with the two non-steering platforms given their own stable colours rather than
 *  falling through to the same grey. */
const tintFor = (p: TsPlatform): string =>
  p === 'Triton' ? '#7b5ea7' : p === 'Unknown' ? '#6b7a90' : colorFor(p);

// --- micro-graphics ---------------------------------------------------------------------------

/** Discrete pass/fail ribbon. Blocks, not a line: these are checks, not a continuum.
 *
 *  Coloured by HEALTH, never by platform. Tinting it per CDN made a perfectly healthy Fastly cell
 *  render solid red, because Fastly's brand colour IS red — a green status dot above a red ribbon
 *  saying "passing". Platform identity belongs to the cell's left edge and the column swatch; red
 *  here means one thing only: a failed check. */
function StatusRibbon({ history, height = 16 }: { history: number[]; height?: number }) {
  if (history.length === 0) return <span className="ts-nodata">no history</span>;
  const w = 5;
  const gap = 1.5;
  const total = history.length * (w + gap) - gap;
  return (
    <svg
      className="ts-ribbon"
      viewBox={`0 0 ${total} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${history.filter((v) => v === 1).length} of ${history.length} recent checks passed`}
    >
      {history.map((v, i) => (
        <rect key={i} x={i * (w + gap)} y={0} width={w} height={height} rx={1} fill={v === 1 ? 'var(--ok)' : 'var(--danger)'} opacity={v === 1 ? 0.85 : 1} />
      ))}
    </svg>
  );
}

/** Coverage arc for the header. Lower is worse, so the unfilled remainder is the story. */
function CoverageArc({ percent, size = 76 }: { percent: number; size?: number }) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, percent)) / 100;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${percent}% coverage`} className="ts-arc">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="7" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${filled * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" className="ts-arc-text">
        {Math.round(percent)}%
      </text>
    </svg>
  );
}

// --- cells ------------------------------------------------------------------------------------

function Cell({
  cell,
  basis,
  rowMax,
  selected,
  onSelect,
}: {
  cell: TsCell;
  basis: Basis;
  rowMax: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const m = cell.monitor;
  if (!m) {
    return (
      <div
        className="ts-cell ts-cell-empty"
        title="No Touchstream monitor exists for this channel, format and CDN — its delivery is unmeasured, not known good"
      >
        <span className="ts-empty-label">not monitored</span>
      </div>
    );
  }
  const tint = tintFor(cell.platform);
  const speed = speedOf(cell, basis);
  const unavailable = basis === 'shared' && speed === null;
  const flag = m.warnings.find((w) => w.kind === 'attribution_mismatch' || w.kind === 'attribution_split');
  const frac = rowMax > 0 && speed !== null ? Math.min(1, speed / rowMax) : 0;
  return (
    <button
      className={`ts-cell${m.ok ? '' : ' failing'}${m.plannedOutage ? ' outage' : ''}${selected ? ' selected' : ''}`}
      style={{ ['--tint' as string]: tint }}
      onClick={onSelect}
      aria-expanded={selected}
      title={`${m.cdnLabel} · ${m.vantages.length} probe${m.vantages.length === 1 ? '' : 's'} — click for probe detail`}
    >
      <span className="ts-cell-row">
        <span className={`ts-dot ${m.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span className="ts-cdn">{m.cdnLabel}</span>
        {flag && (
          <span className="ts-flag" title={flag.message}>
            {flag.kind === 'attribution_split' ? 'edge ≠ label (partly)' : 'edge ≠ label'}
          </span>
        )}
        {m.plannedOutage && <span className="ts-flag ts-flag-quiet">planned</span>}
      </span>
      <span className="ts-cell-ribbon">
        <StatusRibbon history={m.history} />
      </span>
      <span className="ts-cell-row ts-cell-figure">
        <span className="ts-speed">{unavailable ? 'n/a' : fmtSpeed(speed)}</span>
        <span className="ts-speed-note">
          {basis === 'shared'
            ? unavailable
              ? 'no shared probe'
              : `${cell.sharedLocationCount} shared probe${cell.sharedLocationCount === 1 ? '' : 's'}`
            : `${m.vantages.length} probe${m.vantages.length === 1 ? '' : 's'}`}
        </span>
      </span>
      <span className="ts-meter" aria-hidden="true">
        <span className="ts-meter-fill" style={{ width: `${Math.max(2, frac * 100)}%`, background: tint }} />
      </span>
      {basis === 'shared' && cell.unsharedLocations.length > 0 && (
        <span className="ts-excluded" title={`Excluded from the like-for-like figure: ${cell.unsharedLocations.join(', ')}`}>
          −{cell.unsharedLocations.length} not comparable
        </span>
      )}
    </button>
  );
}

function VantageDetail({ monitor, shared }: { monitor: TsMonitor; shared: string[] }) {
  return (
    <div className="ts-detail-col">
      <div className="ts-detail-head">{monitor.cdnLabel}</div>
      {monitor.vantages.map((v: TsVantage) => {
        const inShared = shared.includes(v.location);
        return (
          <div key={v.location} className={`ts-probe${inShared ? '' : ' unshared'}`}>
            <div className="ts-probe-top">
              <span className={`ts-dot ${v.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
              <span className="ts-probe-loc">{v.location}</span>
              <span className="ts-probe-geo">{[v.region, v.country].filter(Boolean).join(', ') || 'location unknown'}</span>
            </div>
            <div className="ts-probe-meta">
              <code>{v.edgeIp ?? 'edge unknown'}</code>
              {v.edgeIsRteOwned === true && <span className="ts-owned" title="Inside an RTÉ-owned prefix">RTÉ</span>}
              <span className="ts-probe-speed">{v.avgSpeed ?? '—'}</span>
              {!inShared && shared.length > 0 && <span className="ts-probe-tag" title="Not probed by every CDN in this row">not shared</span>}
            </div>
            {v.renditions.length > 0 && (
              <div className="ts-rends">
                {v.renditions.map((r) => (
                  <span
                    key={`${r.sequence}-${r.name}`}
                    className={`ts-rend${r.ok ? '' : ' bad'}${r.stalled ? ' stalled' : ''}`}
                    title={[r.label ? `${r.name} · ${r.label}` : r.name, r.resolution, r.httpStatus ? `HTTP ${r.httpStatus}` : null, r.statusText, r.stalled ? 'STALLED' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                ))}
              </div>
            )}
            {v.supplier && <div className="ts-probe-supplier">{v.supplier}</div>}
          </div>
        );
      })}
    </div>
  );
}

// --- grid -------------------------------------------------------------------------------------

function MatrixRow({
  row,
  basis,
  open,
  onToggle,
}: {
  row: TsRow;
  basis: Basis;
  open: boolean;
  onToggle: () => void;
}) {
  const shared = row.comparability.sharedLocations;
  const rowMax = useMemo(() => {
    const values = row.cells.map((c) => speedOf(c, basis)).filter((n): n is number => n !== null);
    return values.length > 0 ? Math.max(...values) : 0;
  }, [row, basis]);
  const monitored = row.cells.filter((c) => c.monitor).length;

  return (
    <>
      <div className={`ts-rowlabel${open ? ' open' : ''}`}>
        <span className="ts-rowchannel">{row.channel}</span>
        <span className="ts-rowfmt">{row.format}</span>
        <span className="ts-rowcount">{monitored}/{row.cells.length}</span>
        {!row.comparability.headlineComparable && (
          <span className={`ts-rowwarn${row.comparability.comparable ? '' : ' hard'}`} title={row.comparability.reason ?? undefined}>
            {row.comparability.comparable ? `≠ basis` : 'not comparable'}
          </span>
        )}
      </div>
      {row.cells.map((c) => (
        <Cell key={c.platform} cell={c} basis={basis} rowMax={rowMax} selected={open} onSelect={onToggle} />
      ))}
      {open && (
        <>
          <div className="ts-detail-label">
            probes
            {shared.length > 0 && <span className="ts-detail-shared">shared: {shared.join(', ')}</span>}
          </div>
          {row.cells.map((c) => (
            <div key={`d-${c.platform}`} className="ts-detail-cell">
              {c.monitor ? <VantageDetail monitor={c.monitor} shared={shared} /> : <span className="ts-detail-none">—</span>}
            </div>
          ))}
        </>
      )}
      {open && row.comparability.reason && (
        <p className="ts-rownote" style={{ gridColumn: `1 / -1` }}>
          {row.comparability.reason}
        </p>
      )}
    </>
  );
}

/** Aggregate for one CDN column across the group's channels — makes a column a unit, not just
 *  alignment. */
function ColumnRail({ platform, rows }: { platform: TsPlatform; rows: TsRow[] }) {
  const monitors = rows.map((r) => r.cells.find((c) => c.platform === platform)?.monitor).filter((m): m is TsMonitor => !!m);
  const tint = tintFor(platform);
  const ok = monitors.filter((m) => m.ok).length;
  const flagged = monitors.filter((m) => m.warnings.some((w) => w.kind === 'attribution_mismatch' || w.kind === 'attribution_split')).length;
  return (
    <div className="ts-rail">
      <span className="ts-rail-name" style={{ color: tint }}>
        <span className="ts-swatch" style={{ background: tint }} aria-hidden="true" />
        {platform}
      </span>
      {monitors.length === 0 ? (
        <span className="ts-rail-empty">not monitored</span>
      ) : (
        <span className="ts-rail-meta">
          {ok}/{monitors.length} passing
          {flagged > 0 && <span className="ts-rail-flag" title="CDN label contradicted by the observed edge on this column"> · {flagged} flagged</span>}
        </span>
      )}
    </div>
  );
}

/** One group = one grid with ONLY the CDNs that serve it.
 *
 *  Video and audio share no CDN — Triton carries radio only, and the video CDNs carry no radio — so a
 *  single shared column set filled a third of the matrix with "not monitored" cells that could never
 *  be anything else. Splitting the grids removes that noise; the "not monitored" cells that remain
 *  are real coverage gaps within a group (RTE2 HLS having no Réalta monitor, say). Cross-group column
 *  alignment is not lost, because there was nothing to compare across it. */
function GroupGrid({
  group,
  basis,
  open,
  onToggle,
}: {
  group: TsGroup;
  basis: Basis;
  open: string | null;
  onToggle: (key: string | null) => void;
}) {
  // Columns are capped rather than stretched: a single-CDN group (audio) would otherwise spread one
  // cell across the full page width.
  const cols = `minmax(130px, 190px) repeat(${group.platforms.length}, minmax(150px, 260px))`;
  return (
    <div className={`ts-groupblock ts-groupblock-${group.kind}`}>
      <div className="ts-group">
        <span className="ts-group-name">{group.label}</span>
        <span className="ts-group-hint">{GROUP_HINT[group.kind] ?? ''}</span>
        <span className="ts-group-count">
          {group.rows.length} stream{group.rows.length === 1 ? '' : 's'} · {group.monitorCount} monitor
          {group.monitorCount === 1 ? '' : 's'} · {group.coveragePercent}% of {group.platforms.length} CDN
          {group.platforms.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="ts-grid" style={{ gridTemplateColumns: cols }}>
        <div className="ts-rail ts-rail-corner">
          <span className="ts-rail-hint">channel · format</span>
        </div>
        {group.platforms.map((p) => (
          <ColumnRail key={p} platform={p} rows={group.rows} />
        ))}
        {group.rows.map((row) => {
          const key = `${row.channel}·${row.format}`;
          return (
            <MatrixRow key={key} row={row} basis={basis} open={open === key} onToggle={() => onToggle(open === key ? null : key)} />
          );
        })}
      </div>
    </div>
  );
}

// --- page -------------------------------------------------------------------------------------

/** Sub-label per group. The grouping itself is decided server-side. */
const GROUP_HINT: Record<string, string> = { video: 'television channels', audio: 'radio streams' };

export function TouchstreamDelivery() {
  const [data, setData] = useState<TsDeliveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [basis, setBasis] = useState<Basis>('headline');
  const [open, setOpen] = useState<string | null>(null);

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

  if (loading) return <p className="muted">Loading Touchstream delivery monitoring…</p>;
  if (error) return <div className="notice warn">{error}</div>;

  const snapshot: TsSnapshot | null = data?.snapshot ?? null;
  if (!snapshot) {
    return (
      <div className="notice info">
        <strong>No Touchstream delivery data.</strong>{' '}
        {data?.reason === 'connector disabled'
          ? 'The connector is switched off. Enable it on the Integrations page and supply the API base plus BOTH credentials — the X-TS-ID app id and the bearer token. Either alone is refused.'
          : 'The connector has not captured a snapshot yet.'}
        {data?.lastError && <div className="mono ts-lasterror">{data.lastError}</div>}
      </div>
    );
  }

  const s = snapshot.summary;
  const mixedBasis = snapshot.rows.some((r) => !r.comparability.headlineComparable);
  const flags = s.attributionMismatchCount + s.attributionSplitCount;

  return (
    <section className="ts-page">
      {/* Instrument header: the read-outs, and the one control that changes what the figures mean. */}
      <div className="ts-console">
        <div className="ts-console-id">
          <span className="ts-eyebrow">Touchstream · delivery monitoring</span>
          <h3 className="ts-console-title">
            {s.channelCount} channels across {s.platformCount} CDNs
          </h3>
          <span className="ts-console-sub">
            <span className={`ts-live ${snapshot.source === 'live' ? 'on' : ''}`}>{snapshot.source === 'live' ? 'LIVE' : 'MOCK'}</span>
            sampled {fmtAge(s.oldestSampleAgeSeconds)} · {s.vantageCount} probe locations
          </span>
        </div>

        <div className="ts-readouts">
          <div className="ts-readout ts-readout-arc">
            <CoverageArc percent={s.coveragePercent} />
            <div>
              <div className="ts-readout-label">coverage</div>
              <div className="ts-readout-sub">
                {s.monitoredCells} of {s.possibleCells} channel×CDN
              </div>
            </div>
          </div>
          <div className="ts-readout">
            <div className={`ts-readout-value${s.failingCount > 0 ? ' bad' : ''}`}>
              {s.okCount}<span className="ts-of">/{s.monitorCount}</span>
            </div>
            <div className="ts-readout-label">passing</div>
          </div>
          <div className="ts-readout">
            <div className="ts-readout-value">
              {s.videoMonitorCount}<span className="ts-of"> · {s.audioMonitorCount}</span>
            </div>
            <div className="ts-readout-label">video · audio</div>
          </div>
          <div className={`ts-readout${flags > 0 ? ' flagged' : ''}`}>
            <div className={`ts-readout-value${flags > 0 ? ' warn' : ''}`}>{flags}</div>
            <div className="ts-readout-label">edge ≠ label</div>
          </div>
        </div>

        <div className="ts-basis">
          <span className="ts-basis-label">speed basis</span>
          <div className="ts-seg" role="group" aria-label="Speed basis">
            <button className={basis === 'headline' ? 'on' : ''} onClick={() => setBasis('headline')}>
              Headline
            </button>
            <button className={basis === 'shared' ? 'on' : ''} onClick={() => setBasis('shared')}>
              Like-for-like
            </button>
          </div>
          <p className="ts-basis-help">
            {basis === 'headline'
              ? mixedBasis
                ? 'As Touchstream reports it. Rows marked ≠ basis are probed from different places, so those figures are not comparable.'
                : 'As Touchstream reports it. Every row’s CDNs share the same probe locations, so these already compare.'
              : 'Restricted to the probe locations every CDN in a row shares, so the comparison isolates the CDN rather than geography.'}
          </p>
        </div>
      </div>

      <p className="ts-provenance">
        Touchstream probes from cloud and datacentre locations, so this is <strong>measured synthetic delivery</strong> — not viewer
        traffic, and not what a subscriber on any ISP received.
      </p>

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

      {snapshot.groups.map((g) => (
        <GroupGrid key={g.kind} group={g} basis={basis} open={open} onToggle={setOpen} />
      ))}
    </section>
  );
}

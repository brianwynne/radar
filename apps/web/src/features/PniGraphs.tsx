// PNI Graphs — a large realtime time-series of every PNI (private-peering) link's bandwidth.
// Data comes from /network/pni-history (persisted per-poll samples, downsampled server-side).
// Interactions:
//   • DRAG the graph left/right to pan through time (up to the last 24h); releasing refetches that
//     window. Panning into the past pauses live-follow; a "Live" button returns to now.
//   • MOVE the mouse across the graph for a vertical crosshair with the time and each PNI's value.
// Filter by PNI (legend chips), pick a direction, and a window width (default 1h). Read-only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { PniHistoryOutage, PniHistoryPoint, PniHistorySeries } from '../api/types';
import { EYEBALL } from '../network/peering';
import { formatBps } from '../telemetry/format';

const RANGES = [
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
] as const;

const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#e11d48', '#a855f7', '#22c55e'];
const DAY_MS = 24 * 60 * 60_000;
const RETENTION_DAYS = 7; // history kept server-side; the day selector spans this many days

const startOfTodayMs = (): number => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Which calendar day (0 = today … N = N days ago) a window ending at `endMs` falls in.
const dayOffsetOf = (endMs: number): number => {
  const d = new Date(endMs - 1); d.setHours(0, 0, 0, 0); // the day the window's last moment is in
  return Math.round((startOfTodayMs() - d.getTime()) / DAY_MS);
};
const dayLabel = (offset: number): string =>
  offset === 0 ? 'Today' : new Date(startOfTodayMs() - offset * DAY_MS).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });

const shortIf = (n: string) => n.replace(/^Port-Channel/, 'Po').replace(/^Ethernet/, 'Et');
const keyOf = (s: { deviceId: string; interfaceName: string }) => `${s.deviceId}::${s.interfaceName}`;
// Datacentre short code so a link's Citywest/Parkwest identity is visible in the key.
const dcCode = (dc: string | null): string => (dc === 'Citywest' ? 'CTW' : dc === 'Parkwest' ? 'PKW' : (dc ?? ''));
const labelOf = (s: PniHistorySeries) => {
  const dc = dcCode(s.datacentre);
  return `${s.provider ?? s.interfaceName}${dc ? ` ${dc}` : ''} ${shortIf(s.interfaceName)}`;
};
// Eyeball = an eyeball-ISP peering link (what the graph shows by default). Match on the PROVIDER
// name (which is reliably populated), and only EXCLUDE when the link type is explicitly non-eyeball
// (transit / IX / inter-DC). This is robust to samples whose link_type is null (older rows, or a
// bucket that predates classification) — an "Eir"/"Sky"/… link is still treated as eyeball.
const NON_EYEBALL_TYPES = new Set(['TRANSIT', 'IX_PEERING', 'INTERNAL']);
const isEyeball = (s: PniHistorySeries): boolean =>
  EYEBALL.test(s.provider ?? s.interfaceName ?? '') && !NON_EYEBALL_TYPES.has(s.linkType ?? '');

// A PNI / eyeball link is a Port-Channel (LAG) bundle. CVaaS sometimes fails to resolve a LAG member's
// bundle (memberOf comes back null), so a stray physical sub-port (e.g. Et8/3/1) leaks in as a bogus
// 0-traffic "PNI" next to its real aggregate. Drop any private-peering / eyeball link that is NOT a
// Port-Channel — the real traffic is on the bundle. (IX / transit / inter-DC on plain Ethernet stay.)
const isUnbundledPni = (s: PniHistorySeries): boolean =>
  !s.interfaceName.startsWith('Port-Channel') &&
  (s.linkType === 'PRIVATE_PEERING' || EYEBALL.test(s.provider ?? ''));

// Group links by role for a neat, sectioned key. Eyeball PNIs first (the default view).
const GROUP_ORDER = ['Eyeball PNI', 'PNI', 'IX', 'Transit', 'Inter-DC', 'Other'] as const;
const groupOf = (s: PniHistorySeries): string => {
  if (isEyeball(s)) return 'Eyeball PNI';
  switch (s.linkType) {
    case 'PRIVATE_PEERING': return 'PNI';
    case 'IX_PEERING': return 'IX';
    case 'TRANSIT': return 'Transit';
    case 'INTERNAL': return 'Inter-DC';
    default: return 'Other';
  }
};

function niceMax(v: number): number {
  if (v <= 0) return 1e6;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hhmmss = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function nearest(points: PniHistoryPoint[], tMs: number): { at: number; p: PniHistoryPoint } | null {
  let best: PniHistoryPoint | null = null;
  let bestAt = 0;
  let bestD = Infinity;
  for (const p of points) {
    const at = Date.parse(p.at);
    const d = Math.abs(at - tMs);
    if (d < bestD) { bestD = d; best = p; bestAt = at; }
  }
  return best ? { at: bestAt, p: best } : null;
}

const W = 960;
const H = 380;
const PAD = { l: 72, r: 16, t: 14, b: 26 };
const PLOT_W = W - PAD.l - PAD.r;

export function PniGraphs() {
  const [minutes, setMinutes] = useState<number>(60);
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [series, setSeries] = useState<PniHistorySeries[]>([]);
  const [bucketSeconds, setBucketSeconds] = useState(15); // server-side downsample interval (display only)
  // Recording gaps, detected server-side at native sample resolution (see the note by `breakMs`).
  const [outages, setOutages] = useState<PniHistoryOutage[]>([]);
  const [gapSeconds, setGapSeconds] = useState(0);
  // null = the default "eyeball-only" view (computed synchronously each render, so there is no
  // first-render flash of all links); a Set = the explicit shown/hidden state after the user filters.
  const [hidden, setHidden] = useState<Set<string> | null>(null);
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // null = live (window ends "now" and polls); a number = paused, viewing a window ending then.
  const [viewEndMs, setViewEndMs] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ startVx: number; startEnd: number } | null>(null);
  const [dragVx, setDragVx] = useState(0);
  const [hoverVx, setHoverVx] = useState<number | null>(null);

  // Fetch on range/pan change; poll only while live (viewEndMs === null).
  useEffect(() => {
    let active = true;
    const live = viewEndMs === null;
    const pollMs = minutes <= 60 ? 10_000 : minutes <= 360 ? 30_000 : 60_000;
    const load = () => {
      api
        .pniHistory(minutes, viewEndMs ?? undefined)
        .then((res) => {
          if (!active) return;
          setSeries(res.series.filter((s) => !isUnbundledPni(s)));
          setBucketSeconds(res.bucketSeconds || 15);
          setOutages(res.outages ?? []);
          setGapSeconds(res.gapSeconds ?? 0);
          setWin({ start: res.windowStartMs, end: res.windowEndMs });
          setUpdatedAt(Date.now());
          setError(null);
          setLoading(false);
        })
        .catch(() => { if (active) { setError('Could not load PNI bandwidth history.'); setLoading(false); } });
    };
    setLoading(true);
    load();
    if (!live) return () => { active = false; };
    const id = setInterval(load, pollMs);
    return () => { active = false; clearInterval(id); };
  }, [minutes, viewEndMs]);

  // Grouped by role (Eyeball PNI first), alphabetical within each group — drives both the sectioned
  // key and the chart's colour order.
  const grouped = useMemo(() => {
    const byLabel = (a: PniHistorySeries, b: PniHistorySeries) => labelOf(a).localeCompare(labelOf(b), undefined, { numeric: true });
    return GROUP_ORDER
      .map((group) => ({ group, items: series.filter((s) => groupOf(s) === group).sort(byLabel) }))
      .filter((g) => g.items.length > 0);
  }, [series]);
  const ordered = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // The default view shows ONLY eyeball links (all links are logged, but non-eyeball are hidden until
  // the user opts in). Derived synchronously → no flash, and stays correct as new links appear.
  const defaultHidden = useMemo(() => new Set(series.filter((s) => !isEyeball(s)).map(keyOf)), [series]);
  const effectiveHidden = hidden ?? defaultHidden;
  const onlyEyeball = () => setHidden(new Set(series.filter((s) => !isEyeball(s)).map(keyOf)));
  const colorByKey = useMemo(() => {
    const m = new Map<string, string>();
    ordered.forEach((s, i) => m.set(keyOf(s), PALETTE[i % PALETTE.length]));
    return m;
  }, [ordered]);
  const visible = ordered.filter((s) => !effectiveHidden.has(keyOf(s)));

  const widthMs = minutes * 60_000;
  const tMax = win ? win.end : (viewEndMs ?? Date.now());
  const tMin = win ? win.start : tMax - widthMs;
  const live = viewEndMs === null;

  // Day selector (last 7 days). Picking a past day views that whole calendar day; "Today" is live.
  const currentDayOffset = live ? 0 : dayOffsetOf(tMax);
  const selectDay = (offset: number) => {
    if (offset === 0) { setViewEndMs(null); return; } // today → live
    setViewEndMs(startOfTodayMs() - (offset - 1) * DAY_MS); // window ends at the end of that day
    setMinutes(1440); // show the whole day; the width buttons then zoom within it
  };

  const val = (p: { inBps: number | null; outBps: number | null }) => (dir === 'out' ? p.outBps : p.inBps);

  const yMax = useMemo(() => {
    let max = 0;
    for (const s of visible) for (const p of s.points) { const v = dir === 'out' ? p.outBps : p.inBps; if (v !== null && v > max) max = v; }
    return niceMax(max);
  }, [visible, dir]);

  // NOTE `outages` comes from the SERVER, detected at native sample resolution — deliberately not
  // re-derived from the points drawn here, because those are bucketed by range: a 5-minute gap
  // survives the 1-minute buckets of the 6h view but is absorbed by the 4-minute buckets of 24h, so
  // the same outage used to appear at one zoom level and vanish at another.
  //
  // `breakMs` is purely a RENDERING threshold: how far apart two plotted points may be before the line is broken
  // rather than interpolated. Bucket-relative is correct here (it is about the drawn points), and it
  // still breaks a single link's own quiet period, which is not a recorder outage.
  const breakMs = Math.max(bucketSeconds * 2.5, 45) * 1000;
  // Break where a gap BEGINS. Gap bounds are native sample times while these points are bucket
  // starts, so a gap seldom sits neatly between two plotted points: requiring the whole gap to fall
  // between them draws the line straight through the shaded band, while breaking on any overlap
  // breaks twice (the bucket holding the first sample after the gap starts before the gap ends).
  // "Starts in this interval" is true for exactly one interval per gap.
  const brokenAt = useMemo(
    () => (a: number, b: number) => b - a > breakMs || outages.some((g) => g.fromMs >= a && g.fromMs < b),
    [breakMs, outages],
  );

  const x = (t: number) => PAD.l + ((t - tMin) / Math.max(1, tMax - tMin)) * PLOT_W;
  const y = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = Array.from({ length: 6 }, (_, i) => tMin + (i / 5) * (tMax - tMin));

  const latest = (s: PniHistorySeries): number | null => {
    for (let i = s.points.length - 1; i >= 0; i--) { const v = val(s.points[i]); if (v !== null) return v; }
    return null;
  };
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h ?? defaultHidden); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // Legend groups are collapsed by default (compact key); `expandedGroups` holds the opened ones.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroupCollapse = (group: string) => setExpandedGroups((g) => { const n = new Set(g); if (n.has(group)) n.delete(group); else n.add(group); return n; });

  // Pointer → viewBox X (independent of the SVG's rendered/scaled width).
  const toVx = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return PAD.l;
    return ((clientX - rect.left) / rect.width) * W;
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setHoverVx(null);
    setDrag({ startVx: toVx(e.clientX), startEnd: tMax });
  };
  const onMove = (e: React.MouseEvent) => {
    const vx = toVx(e.clientX);
    if (drag) setDragVx(vx - drag.startVx);
    else setHoverVx(vx);
  };
  const commitDrag = () => {
    if (!drag) return;
    const dtMs = -(dragVx / PLOT_W) * widthMs; // drag right → reveal earlier → end decreases
    const nowMs = Date.now();
    const newEnd = Math.min(nowMs, Math.max(nowMs - RETENTION_DAYS * DAY_MS, drag.startEnd + dtMs));
    setViewEndMs(newEnd >= nowMs - 1500 ? null : newEnd); // snapped back to now ⇒ resume live
    setDrag(null);
    setDragVx(0);
  };
  const onLeave = () => { commitDrag(); setHoverVx(null); };

  // Crosshair readout at the hovered time.
  const showCross = hoverVx !== null && !drag && hoverVx >= PAD.l && hoverVx <= W - PAD.r;
  const tHover = showCross ? tMin + ((hoverVx! - PAD.l) / PLOT_W) * (tMax - tMin) : 0;
  const readout = showCross
    ? visible.map((s) => {
        const n = nearest(s.points, tHover);
        const v = n ? val(n.p) : null;
        return { key: keyOf(s), label: labelOf(s), color: colorByKey.get(keyOf(s))!, at: n?.at ?? null, v };
      }).filter((r) => r.v !== null)
    : [];

  return (
    <section className="card pni-graphs">
      <div className="pni-controls">
        <label className="field pni-day">
          <span>Day</span>
          <select value={currentDayOffset} onChange={(e) => selectDay(Number(e.target.value))} aria-label="Day">
            {Array.from({ length: RETENTION_DAYS }, (_, d) => (
              <option key={d} value={d}>{dayLabel(d)}{d === 0 ? ' (live)' : ''}</option>
            ))}
          </select>
        </label>
        <div className="pni-ranges" role="group" aria-label="Window">
          {RANGES.map((r) => (
            <button key={r.minutes} className={`subtab ${minutes === r.minutes ? 'active' : ''}`} onClick={() => setMinutes(r.minutes)}>{r.label}</button>
          ))}
        </div>
        <div className="pni-dir" role="group" aria-label="Direction">
          <button className={`subtab ${dir === 'out' ? 'active' : ''}`} onClick={() => setDir('out')}>Out</button>
          <button className={`subtab ${dir === 'in' ? 'active' : ''}`} onClick={() => setDir('in')}>In</button>
        </div>
        {live ? (
          <span className="badge live-countdown"><span className="live-dot" />live{updatedAt ? ` · ${hhmm(updatedAt)}` : ''}</span>
        ) : (
          <button className="btn btn-sm" onClick={() => setViewEndMs(null)} title="Return to the live (most recent) window">◀ Live · viewing {hhmm(tMin)}–{hhmm(tMax)}</button>
        )}
        <div className="pni-meta muted">
          {loading ? 'loading…' : 'drag to pan · hover for values'}
          {!loading && outages.length > 0 && (
            <span
              className="pni-gap-note"
              title={`A gap is more than ${gapSeconds}s with no sample stored on any link — measured against the recorder's poll cadence, so the same gaps show at every range.`}
            >
              {' · '}{outages.length} recording gap{outages.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {error && <div className="notice warn">{error}</div>}

      {!loading && series.length === 0 ? (
        <div className="center-note" style={{ padding: '2rem 0' }}>
          No PNI bandwidth recorded for this window. Samples are captured on every CloudVision poll and
          the graph fills in over time (the full 24h view needs ~24h of running).
        </div>
      ) : (
        <>
          <div className="pni-chart-wrap">
            <svg
              ref={svgRef}
              className="pni-chart"
              viewBox={`0 0 ${W} ${H}`}
              width="100%"
              role="img"
              aria-label={`PNI ${dir === 'out' ? 'outbound' : 'inbound'} bandwidth over the last ${minutes} minutes`}
              style={{ cursor: drag ? 'grabbing' : 'crosshair', userSelect: 'none' }}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={commitDrag}
              onMouseLeave={onLeave}
            >
              <defs><clipPath id="pni-plot"><rect x={PAD.l} y={PAD.t} width={PLOT_W} height={H - PAD.t - PAD.b} /></clipPath></defs>
              {yTicks.map((v, i) => (
                <g key={i}>
                  <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="pni-grid" />
                  <text x={PAD.l - 8} y={y(v) + 3} textAnchor="end" className="pni-axis">{formatBps(v)}</text>
                </g>
              ))}
              {xTicks.map((t, i) => (
                <text key={i} x={x(t)} y={H - PAD.b + 16} textAnchor="middle" className="pni-axis">{hhmm(t)}</text>
              ))}
              {/* Recording gaps: shade + label the windows RADAR stored no samples at all. The label
                  claims only what RADAR can know — that nothing was recorded, not that a link or the
                  server was down; the tooltip names the possible causes. */}
              <g clipPath="url(#pni-plot)" transform={drag ? `translate(${dragVx} 0)` : undefined}>
                {outages.map((g, i) => {
                  const x0 = Math.max(PAD.l, x(g.fromMs));
                  const x1 = Math.min(W - PAD.r, x(g.toMs));
                  if (x1 - x0 < 1) return null;
                  const mins = Math.max(1, Math.round((g.toMs - g.fromMs) / 60_000));
                  return (
                    <g key={`out-${i}`}>
                      <rect x={x0} y={PAD.t} width={Math.max(2, x1 - x0)} height={H - PAD.t - PAD.b} className="pni-outage">
                        <title>{`No telemetry recorded for ~${mins} min (${hhmm(g.fromMs)}–${hhmm(g.toMs)}). RADAR stored no samples on any link: the API was down or restarting, the CloudVision poll failed, or the write failed. Traffic itself is not known to have stopped.`}</title>
                      </rect>
                      {x1 - x0 > 60 && <text x={(x0 + x1) / 2} y={PAD.t + 13} textAnchor="middle" className="pni-outage-label">no telemetry recorded</text>}
                    </g>
                  );
                })}
              </g>
              {/* Series (clipped to the plot, translated live while dragging for immediate feedback).
                  Lines BREAK across a recording gap so an outage is never drawn as a flat line. */}
              <g clipPath="url(#pni-plot)" transform={drag ? `translate(${dragVx} 0)` : undefined}>
                {visible.map((s) => {
                  const pts = s.points.map((p) => ({ t: Date.parse(p.at), v: val(p) })).filter((p) => p.v !== null) as { t: number; v: number }[];
                  if (pts.length === 0) return null;
                  // Split into contiguous segments wherever consecutive samples straddle a gap.
                  const segs: { t: number; v: number }[][] = [];
                  let cur: { t: number; v: number }[] = [];
                  for (let i = 0; i < pts.length; i++) {
                    if (i > 0 && brokenAt(pts[i - 1].t, pts[i].t)) { segs.push(cur); cur = []; }
                    cur.push(pts[i]);
                  }
                  if (cur.length) segs.push(cur);
                  const color = colorByKey.get(keyOf(s));
                  return segs.map((seg, si) => (
                    <polyline key={`${keyOf(s)}-${si}`} points={seg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth={1.75} />
                  ));
                })}
              </g>
              {/* Crosshair */}
              {showCross && (
                <g>
                  <line x1={hoverVx!} x2={hoverVx!} y1={PAD.t} y2={H - PAD.b} className="pni-cross" />
                  {readout.map((r) => (
                    <circle key={r.key} cx={x(r.at!)} cy={y(r.v!)} r={3} fill={r.color} stroke="var(--panel)" strokeWidth={1} />
                  ))}
                </g>
              )}
            </svg>
            {showCross && readout.length > 0 && (
              <div className={`pni-tooltip ${hoverVx! > W * 0.62 ? 'flip' : ''}`} style={{ left: `${(hoverVx! / W) * 100}%` }}>
                <div className="pni-tt-time">{hhmmss(tHover)}</div>
                {readout.map((r) => (
                  <div className="pni-tt-row" key={r.key}>
                    <span className="pni-swatch" style={{ background: r.color }} />
                    <span className="pni-tt-label">{r.label}</span>
                    <span className="pni-tt-val">{formatBps(r.v)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pni-legend">
            <div className="pni-legend-actions">
              <button className="btn btn-sm" onClick={onlyEyeball} title="Show only the eyeball-ISP PNIs">Eyeball</button>
              <button className="btn btn-sm" onClick={() => setHidden(new Set())}>All</button>
              <button className="btn btn-sm" onClick={() => setHidden(new Set(ordered.map(keyOf)))}>None</button>
              <span className="muted" style={{ fontSize: '0.72rem' }}>{visible.length}/{ordered.length} shown</span>
            </div>
            {grouped.map(({ group, items }) => {
              const shownInGroup = items.filter((s) => !effectiveHidden.has(keyOf(s))).length;
              const expanded = expandedGroups.has(group);
              return (
                <div key={group} className="pni-group">
                  <button className="pni-group-head" onClick={() => toggleGroupCollapse(group)} aria-expanded={expanded} title="Expand/collapse this group">
                    <span className="pni-group-caret">{expanded ? '▾' : '▸'}</span> {group} <span className="muted">({shownInGroup}/{items.length} shown)</span>
                  </button>
                  {expanded && (
                    <div className="pni-chips">
                      {items.map((s) => {
                        const k = keyOf(s);
                        const off = effectiveHidden.has(k);
                        const v = latest(s);
                        return (
                          <button key={k} className={`pni-chip ${off ? 'off' : ''}`} onClick={() => toggle(k)} title={`${s.provider ?? ''} ${s.interfaceName}`}>
                            <span className="pni-swatch" style={{ background: off ? 'var(--line)' : colorByKey.get(k) }} />
                            <span className="pni-chip-label">{labelOf(s)}</span>
                            <span className="pni-chip-val">{v === null ? '—' : formatBps(v)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

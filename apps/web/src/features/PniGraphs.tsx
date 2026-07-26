// PNI Graphs — a large realtime time-series of every PNI (private-peering) link's bandwidth.
// Data comes from /network/pni-history (persisted per-poll samples, downsampled server-side), fetched
// on range change and re-polled for realtime. Filter by PNI (legend chips toggle series), pick a
// direction, and select a range up to the last 24 hours (default 1 hour). Read-only.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { PniHistorySeries } from '../api/types';
import { formatBps } from '../telemetry/format';

const RANGES = [
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
] as const;

// Distinct, reasonably colour-blind-friendly line colours; assigned by stable series order.
const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#e11d48', '#a855f7', '#22c55e'];

const shortIf = (n: string) => n.replace(/^Port-Channel/, 'Po').replace(/^Ethernet/, 'Et');
const keyOf = (s: { deviceId: string; interfaceName: string }) => `${s.deviceId}::${s.interfaceName}`;
const labelOf = (s: PniHistorySeries) => `${s.provider ?? s.interfaceName} ${shortIf(s.interfaceName)}`;

function niceMax(v: number): number {
  if (v <= 0) return 1e6;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// SVG geometry (scales to the container via viewBox).
const W = 960;
const H = 380;
const PAD = { l: 72, r: 16, t: 14, b: 26 };

export function PniGraphs() {
  const [minutes, setMinutes] = useState<number>(60);
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [series, setSeries] = useState<PniHistorySeries[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Fetch on range change, then poll for realtime (cadence scaled to the range).
  useEffect(() => {
    let active = true;
    const pollMs = minutes <= 60 ? 10_000 : minutes <= 360 ? 30_000 : 60_000;
    const load = () => {
      api
        .pniHistory(minutes)
        .then((res) => {
          if (!active) return;
          setSeries(res.series);
          setUpdatedAt(Date.now());
          setError(null);
          setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setError('Could not load PNI bandwidth history.');
          setLoading(false);
        });
    };
    setLoading(true);
    load();
    const id = setInterval(load, pollMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [minutes]);

  // Stable colour per PNI (by label order) so toggling series never recolours the rest.
  const ordered = useMemo(() => [...series].sort((a, b) => labelOf(a).localeCompare(labelOf(b))), [series]);
  const colorByKey = useMemo(() => {
    const m = new Map<string, string>();
    ordered.forEach((s, i) => m.set(keyOf(s), PALETTE[i % PALETTE.length]));
    return m;
  }, [ordered]);

  const visible = ordered.filter((s) => !hidden.has(keyOf(s)));

  // Fixed window = the selected range ending now, so the graph scrolls in realtime.
  const now = updatedAt ?? Date.now();
  const tMax = now;
  const tMin = now - minutes * 60_000;

  const val = (p: { inBps: number | null; outBps: number | null }) => (dir === 'out' ? p.outBps : p.inBps);

  const yMax = useMemo(() => {
    let max = 0;
    for (const s of visible) for (const p of s.points) { const v = dir === 'out' ? p.outBps : p.inBps; if (v !== null && v > max) max = v; }
    return niceMax(max);
  }, [visible, dir]);

  const x = (t: number) => PAD.l + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = Array.from({ length: 6 }, (_, i) => tMin + (i / 5) * (tMax - tMin));

  const latest = (s: PniHistorySeries): number | null => {
    for (let i = s.points.length - 1; i >= 0; i--) { const v = val(s.points[i]); if (v !== null) return v; }
    return null;
  };

  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const showAll = () => setHidden(new Set());
  const hideAll = () => setHidden(new Set(ordered.map(keyOf)));

  return (
    <section className="card pni-graphs">
      <div className="pni-controls">
        <div className="pni-ranges" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.minutes} className={`subtab ${minutes === r.minutes ? 'active' : ''}`} onClick={() => setMinutes(r.minutes)}>{r.label}</button>
          ))}
        </div>
        <div className="pni-dir" role="group" aria-label="Direction">
          <button className={`subtab ${dir === 'out' ? 'active' : ''}`} onClick={() => setDir('out')}>Out</button>
          <button className={`subtab ${dir === 'in' ? 'active' : ''}`} onClick={() => setDir('in')}>In</button>
        </div>
        <div className="pni-meta muted">
          {loading ? 'loading…' : updatedAt ? `updated ${hhmm(updatedAt)}` : ''}
        </div>
      </div>

      {error && <div className="notice warn">{error}</div>}

      {!loading && visible.length === 0 && series.length === 0 ? (
        <div className="center-note" style={{ padding: '2rem 0' }}>
          No PNI bandwidth recorded yet for this range. Samples are captured on every CloudVision poll and
          the graph fills in over time (the full 24h view needs ~24h of running).
        </div>
      ) : (
        <>
          <svg className="pni-chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`PNI ${dir === 'out' ? 'outbound' : 'inbound'} bandwidth over the last ${minutes} minutes`}>
            {/* Y grid + labels */}
            {yTicks.map((v, i) => (
              <g key={i}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="pni-grid" />
                <text x={PAD.l - 8} y={y(v) + 3} textAnchor="end" className="pni-axis">{formatBps(v)}</text>
              </g>
            ))}
            {/* X labels */}
            {xTicks.map((t, i) => (
              <text key={i} x={x(t)} y={H - PAD.b + 16} textAnchor="middle" className="pni-axis">{hhmm(t)}</text>
            ))}
            {/* Series lines */}
            {visible.map((s) => {
              const pts = s.points
                .map((p) => ({ t: Date.parse(p.at), v: val(p) }))
                .filter((p) => p.v !== null && p.t >= tMin) as { t: number; v: number }[];
              if (pts.length === 0) return null;
              const d = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
              return <polyline key={keyOf(s)} points={d} fill="none" stroke={colorByKey.get(keyOf(s))} strokeWidth={1.75} />;
            })}
          </svg>

          <div className="pni-legend">
            <div className="pni-legend-actions">
              <button className="btn btn-sm" onClick={showAll}>All</button>
              <button className="btn btn-sm" onClick={hideAll}>None</button>
              <span className="muted" style={{ fontSize: '0.72rem' }}>{visible.length}/{ordered.length} PNIs</span>
            </div>
            <div className="pni-chips">
              {ordered.map((s) => {
                const k = keyOf(s);
                const off = hidden.has(k);
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
          </div>
        </>
      )}
    </section>
  );
}

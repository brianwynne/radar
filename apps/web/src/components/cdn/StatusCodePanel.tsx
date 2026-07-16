// Realtime HTTP status-code panel for a single CDN service: 2xx / 3xx / 4xx / 5xx over a rolling
// window, one cell per class (latest value + share + a sparkline). Each class cell is clickable and
// expands into the individual codes within it (e.g. 2xx → 200/206, 4xx → 403/404), each with its own
// latest value, share of the class, and sparkline. Presentational and source-agnostic — it takes
// already-shaped points, so it serves Fastly's per-second stream and Akamai's 5-min buckets alike.
// Missing data → shown as such, never fabricated.
import { useState } from 'react';
import { Sparkline } from '../../telemetry/Sparkline';

export interface StatusCodePoint {
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  /** Per specific code with traffic this point, e.g. { "200": 680, "404": 12 }. Enables drill-down. */
  codes?: Record<string, number>;
}

export interface StatusCodePanelProps {
  points: StatusCodePoint[];
  /** e.g. "per-second" or "5-min" — describes the cadence of each point. */
  cadenceLabel: string;
  /** When false the panel shows an inert "not streaming" state (no fabricated values). */
  live: boolean;
}

const CLASSES = [
  { key: 'status2xx', label: '2xx', digit: '2', tone: 'ok' as const },
  { key: 'status3xx', label: '3xx', digit: '3', tone: 'neutral' as const },
  { key: 'status4xx', label: '4xx', digit: '4', tone: 'warn' as const },
  { key: 'status5xx', label: '5xx', digit: '5', tone: 'crit' as const },
] as const;

const fmt = (n: number | null): string => (n === null ? '—' : n.toLocaleString());

export function StatusCodePanel({ points, cadenceLabel, live }: StatusCodePanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const latestTotal = latest ? latest.status2xx + latest.status3xx + latest.status4xx + latest.status5xx : 0;

  return (
    <div className="status-panel">
      <div className="status-panel-head">
        <span className="muted" style={{ fontSize: '0.72rem' }}>Response codes <span style={{ opacity: 0.7 }}>· click a class for detail</span></span>
        {live
          ? <span className="badge live-countdown"><span className="live-dot" />{cadenceLabel}</span>
          : <span className="muted" style={{ fontSize: '0.72rem' }}>not streaming</span>}
      </div>
      <div className="grid cols-4" style={{ gap: '0.4rem' }}>
        {CLASSES.map((c) => {
          const series = points.map((p) => p[c.key]);
          const value = latest ? latest[c.key] : null;
          const share = latest && latestTotal > 0 ? Math.round((latest[c.key] / latestTotal) * 100) : null;
          const alert = (c.tone === 'crit' && (share ?? 0) > 0) || (c.tone === 'warn' && (share ?? 0) >= 5);
          const isOpen = expanded === c.label;
          return (
            <button
              key={c.key}
              type="button"
              className={`card status-cell ${alert ? (c.tone === 'crit' ? 'util-crit' : 'util-warn') : ''} ${isOpen ? 'status-cell-open' : ''}`}
              aria-expanded={isOpen}
              onClick={() => setExpanded(isOpen ? null : c.label)}
            >
              <div className="muted" style={{ fontSize: '0.72rem' }}>{c.label}</div>
              <div className="stat" style={{ lineHeight: 1.1, fontSize: '1.1rem' }}>{fmt(value)}</div>
              <div className="muted" style={{ fontSize: '0.68rem' }}>{share === null ? '' : `${share}%`}</div>
              <Sparkline data={series} width={120} height={22} ariaLabel={`${c.label} responses ${cadenceLabel}`} />
            </button>
          );
        })}
      </div>
      {expanded && <CodeDetail points={points} classLabel={expanded} />}
    </div>
  );
}

const CLASS_FIELD: Record<string, keyof StatusCodePoint> = { '2': 'status2xx', '3': 'status3xx', '4': 'status4xx', '5': 'status5xx' };

/** Individual codes within a class, over the window. Because a CDN reports only a curated set of
 *  specific codes, the known codes may not sum to the class total — the shortfall is shown honestly
 *  as an "other" row rather than silently dropped. Shares are of the true class total. */
function CodeDetail({ points, classLabel }: { points: StatusCodePoint[]; classLabel: string }) {
  const digit = classLabel[0];
  const field = CLASS_FIELD[digit];
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const classLatest = latest ? (latest[field] as number) : 0;

  const knownSum = (p: StatusCodePoint): number =>
    Object.entries(p.codes ?? {}).reduce((a, [code, n]) => (code[0] === digit ? a + n : a), 0);

  const codeSet = new Set<string>();
  for (const p of points) for (const code of Object.keys(p.codes ?? {})) if (code[0] === digit) codeSet.add(code);

  const rows = [...codeSet]
    .map((code) => ({
      code,
      latest: latest?.codes?.[code] ?? 0,
      total: points.reduce((a, p) => a + (p.codes?.[code] ?? 0), 0),
      series: points.map((p) => p.codes?.[code] ?? 0),
    }))
    .sort((a, b) => b.latest - a.latest || b.total - a.total);

  // Shortfall between the class total and the sum of individually-reported codes.
  const otherSeries = points.map((p) => Math.max(0, (p[field] as number) - knownSum(p)));
  const otherLatest = latest ? Math.max(0, classLatest - knownSum(latest)) : 0;
  const otherTotal = otherSeries.reduce((a, n) => a + n, 0);

  const pct = (n: number): string => (classLatest > 0 ? `${Math.round((n / classLatest) * 100)}%` : '');

  return (
    <div className="code-detail">
      <div className="muted" style={{ fontSize: '0.72rem', marginBottom: '0.3rem' }}>{classLabel} codes</div>
      {rows.length === 0 && otherTotal === 0 ? (
        <div className="center-note" style={{ padding: '0.4rem 0' }}>no per-code detail in this window</div>
      ) : (
        <>
          {rows.map((r) => (
            <div key={r.code} className="code-row">
              <span className="code-num">{r.code}</span>
              <span className="code-val">{r.latest.toLocaleString()}</span>
              <span className="muted code-share">{pct(r.latest)}</span>
              <Sparkline data={r.series} width={90} height={18} ariaLabel={`code ${r.code} trend`} />
            </div>
          ))}
          {otherTotal > 0 && (
            <div className="code-row" title="Codes in this class the CDN does not break out individually">
              <span className="code-num muted">other</span>
              <span className="code-val">{otherLatest.toLocaleString()}</span>
              <span className="muted code-share">{pct(otherLatest)}</span>
              <Sparkline data={otherSeries} width={90} height={18} ariaLabel={`other ${classLabel} trend`} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

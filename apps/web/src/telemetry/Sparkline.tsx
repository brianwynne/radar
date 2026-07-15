// Dependency-free inline-SVG sparkline. RADAR ships no charting library and the "one
// architecture" mandate says keep it that way — this is ~self-contained SVG, themeable via
// currentColor, with an area fill + line and an optional threshold marker. Null points are
// gaps (never invented). Purely presentational.
import { useId } from 'react';

export interface SparklineProps {
  data: (number | null)[];
  width?: number;
  height?: number;
  /** Force the value axis to start at zero (utilisation/throughput read better zero-based). */
  zeroBased?: boolean;
  /** Optional horizontal marker (e.g. a capacity line) in the same units as data. */
  marker?: number | null;
  color?: string;
  ariaLabel?: string;
}

export function Sparkline({ data, width = 240, height = 44, zeroBased = true, marker = null, color = 'currentColor', ariaLabel }: SparklineProps) {
  const gradId = useId();
  const values = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) {
    return (
      <svg className="sparkline" width={width} height={height} role="img" aria-label={ariaLabel ?? 'no data'}>
        <text x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle" className="sparkline-empty">
          no data
        </text>
      </svg>
    );
  }

  const pad = 3;
  const max = Math.max(...values, marker ?? -Infinity);
  const min = zeroBased ? 0 : Math.min(...values, marker ?? Infinity);
  const span = max - min || 1;
  const n = data.length;
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);

  // Build the line path, breaking at null gaps.
  let d = '';
  let penDown = false;
  data.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      penDown = false;
      return;
    }
    d += `${penDown ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    penDown = true;
  });

  // Area path (only meaningful for a contiguous series; anchored to the baseline).
  const firstIdx = data.findIndex((v) => v !== null && Number.isFinite(v));
  const lastIdx = data.length - 1 - [...data].reverse().findIndex((v) => v !== null && Number.isFinite(v));
  const area = `${d.replace(/^M/, 'M').trim()} L${x(lastIdx).toFixed(1)},${(height - pad).toFixed(1)} L${x(firstIdx).toFixed(1)},${(height - pad).toFixed(1)} Z`;

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel ?? 'trend'} style={{ color }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 && <path d={area} fill={`url(#${gradId})`} stroke="none" />}
      <path d={d.trim()} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {marker !== null && Number.isFinite(marker) && marker <= max && (
        <line x1={pad} x2={width - pad} y1={y(marker)} y2={y(marker)} stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
      )}
    </svg>
  );
}

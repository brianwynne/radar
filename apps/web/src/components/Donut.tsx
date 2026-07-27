// A small, reusable donut/pie for showing a distribution (delivery-platform mix, etc.). Pure SVG,
// theme-aware via CSS vars. A single 100% datum renders as a full ring; an empty set as a grey ring.
export interface DonutDatum { label: string; value: number; color: string }

const TAU = Math.PI * 2;
const polar = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
function seg(a0: number, a1: number, R: number, r: number, cx: number, cy: number): string {
  const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1);
  const [xi1, yi1] = polar(cx, cy, r, a1), [xi0, yi0] = polar(cx, cy, r, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${xi1} ${yi1} A${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z`;
}

export function Donut({ data, size = 120, thickness, ariaLabel = 'distribution' }: { data: DonutDatum[]; size?: number; thickness?: number; ariaLabel?: string }) {
  const th = thickness ?? size * 0.34;
  const R = size / 2, r = R - th, cx = R, cy = R;
  const parts = data.filter((d) => d.value > 0);
  const sum = parts.reduce((s, d) => s + d.value, 0);
  let acc = 0;
  const arcs = sum > 0 ? parts.map((d) => {
    const f = d.value / sum;
    const a0 = acc * TAU - Math.PI / 2; acc += f; const a1 = acc * TAU - Math.PI / 2;
    return { d, a0, a1, f };
  }) : [];

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={ariaLabel}>
      {sum <= 0 && <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke="var(--line)" strokeWidth={th} />}
      {arcs.length === 1 && <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke={arcs[0].d.color} strokeWidth={th} />}
      {arcs.length > 1 && arcs.map((a) => (
        <path key={a.d.label} d={seg(a.a0, a.a1, R, r, cx, cy)} fill={a.d.color}>
          <title>{a.d.label}: {Math.round(a.f * 100)}%</title>
        </path>
      ))}
    </svg>
  );
}

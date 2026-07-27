// Dashboard delivery pie: live delivery to each eyeball network (via RTÉ's Réalta CDN) and by the
// commercial CDNs (Fastly, Akamai), as a donut, with the total live throughput and a 1-hour average.
// Read-only. Absent values render as '—', never invented.
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { DashboardDeliveryResponse, DeliverySlice } from '../api/types';
import { formatBps, formatPercent } from '../telemetry/format';

// Réalta (eyeball) slices take green shades; commercial CDNs keep their brand colours (Fastly red,
// Akamai blue) — matching the Steering-overview legend.
const GREENS = ['#1a7f4b', '#2ecc71', '#159a5b', '#3ddc84', '#0f6e3f', '#5eead4'];
const colourFor = (s: DeliverySlice, eyeballIndex: number): string =>
  s.platform === 'Fastly' ? '#e2483a'
    : s.platform === 'Akamai' ? '#3b82f6'
      : s.kind === 'ix' ? '#14b8a6' // Réalta over public IX peering — teal, distinct from the PNI greens
        : GREENS[eyeballIndex % GREENS.length];

const TAU = Math.PI * 2;
const polar = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
function donutSeg(a0: number, a1: number, R: number, r: number, cx: number, cy: number): string {
  const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1);
  const [xi1, yi1] = polar(cx, cy, r, a1), [xi0, yi0] = polar(cx, cy, r, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${xi1} ${yi1} A${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z`;
}

export function DeliveryPie() {
  const [data, setData] = useState<DashboardDeliveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => api.dashboardDelivery()
      .then((d) => { if (active) { setData(d); setError(null); } })
      .catch((e) => { if (active) setError(e instanceof ApiError ? e.message : 'Failed to load delivery data.'); });
    load();
    const id = setInterval(load, 15_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const slices = data?.live.slices ?? [];
  const total = data?.live.totalBps ?? 0;
  const segments = useMemo(() => {
    if (total <= 0) return [];
    let acc = 0, eye = 0;
    return slices.map((s) => {
      const frac = s.bps / total;
      const a0 = acc * TAU - Math.PI / 2; acc += frac; const a1 = acc * TAU - Math.PI / 2;
      const colour = colourFor(s, s.kind === 'eyeball' ? eye++ : 0);
      return { s, frac, a0, a1, colour };
    });
  }, [slices, total]);

  const R = 82, r = 52, cx = 92, cy = 92;
  const single = segments.length === 1;

  return (
    <section className="card delivery-pie">
      <div className="delivery-pie-head">
        <h2 style={{ margin: 0 }}>Live delivery mix</h2>
        <span className="muted">Réalta to each eyeball network + commercial CDNs · updates every 15s</span>
      </div>

      {error && <div className="notice info">{error} The delivery mix needs CloudVision and the commercial-CDN connectors.</div>}

      <div className="delivery-pie-body">
        <div className="delivery-pie-chart">
          <svg viewBox="0 0 184 184" width="184" height="184" role="img" aria-label="Live delivery mix by platform">
            {total <= 0 ? (
              <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke="var(--line)" strokeWidth={R - r} />
            ) : single ? (
              <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke={segments[0].colour} strokeWidth={R - r} />
            ) : (
              segments.map((seg) => (
                <path key={seg.s.label} d={donutSeg(seg.a0, seg.a1, R, r, cx, cy)} fill={seg.colour}>
                  <title>{seg.s.label}: {formatBps(seg.s.bps)} ({Math.round(seg.frac * 100)}%){seg.s.links > 1 ? ` · summed over ${seg.s.links} ${seg.s.kind === 'commercial' ? 'services' : 'links'}` : ''}</title>
                </path>
              ))
            )}
            <text x={cx} y={cy - 4} textAnchor="middle" className="delivery-pie-total">{formatBps(total)}</text>
            <text x={cx} y={cy + 14} textAnchor="middle" className="delivery-pie-sub">live total</text>
          </svg>
        </div>

        <div className="delivery-pie-side">
          <div className="delivery-pie-stats">
            <div><span className="muted">Total live</span><strong>{formatBps(total)}</strong></div>
            <div>
              <span className="muted">Avg · last {data?.average.windowMinutes ?? 60} min</span>
              <strong>{data && data.average.sampleCount > 0 ? formatBps(data.average.avgTotalBps) : '—'}</strong>
            </div>
            <div><span className="muted">Réalta / commercial</span><strong>{formatBps(data?.live.realtaBps)} <span className="muted">/</span> {formatBps(data?.live.commercialBps)}</strong></div>
          </div>

          <ul className="delivery-legend">
            {segments.length === 0 && <li className="muted">No live delivery observed.</li>}
            {segments.map((seg) => (
              <li key={seg.s.label} className={seg.s.kind !== 'eyeball' ? 'delivery-legend-sep' : undefined}>
                <span className="delivery-dot" style={{ background: seg.colour }} />
                <span className="delivery-legend-label">
                  {seg.s.label}
                  {seg.s.kind === 'eyeball' && <span className="muted"> · Réalta PNI</span>}
                  {seg.s.kind === 'ix' && <span className="muted"> · Réalta · public peering</span>}
                  {seg.s.links > 1 && <span className="muted"> · {seg.s.links} {seg.s.kind === 'commercial' ? 'services' : 'links'}</span>}
                </span>
                <span className="delivery-legend-val">{formatBps(seg.s.bps)} <span className="muted">{Math.round(seg.frac * 100)}%</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Per-link utilisation for multi-link PNIs — both links and each one's real % utilisation
          (delivery out-bps ÷ capacity), so a 2×PNI network isn't collapsed to one figure. */}
      {segments.some((seg) => (seg.s.linkDetails?.length ?? 0) > 1) && (
        <div className="delivery-links">
          <div className="delivery-links-title">PNI links · utilisation</div>
          {segments.filter((seg) => (seg.s.linkDetails?.length ?? 0) > 1).map((seg) => (
            <div key={seg.s.label} className="delivery-link-group">
              <div className="delivery-link-net">
                <span className="delivery-dot" style={{ background: seg.colour }} />
                <strong>{seg.s.label}</strong>
                <span className="muted"> · {seg.s.links} links · {formatBps(seg.s.bps)} total</span>
              </div>
              {seg.s.linkDetails!.map((l) => (
                <div key={`${l.device}·${l.iface}`} className="delivery-link-row">
                  <span className="delivery-link-name">{l.device} <span className="muted">{l.iface}</span></span>
                  <span className="delivery-link-bw">{formatBps(l.bps)} <span className="muted">/ {formatBps(l.capacityBps)}</span></span>
                  <span className="delivery-link-util">{formatPercent(l.utilisationPercent)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {data && data.average.sampleCount === 0 && (
        <p className="muted delivery-pie-foot">The 1-hour average fills in as samples accrue (first hour after start).</p>
      )}
    </section>
  );
}

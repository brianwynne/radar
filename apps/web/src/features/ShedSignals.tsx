// Shed Signals — a realtime per-(ISP × datacentre) egress-utilisation grid overlaid with the NS1
// shed_load gating RADAR WOULD feed to NS1. Read-only / dry-run: nothing is sent to NS1. Utilisation
// polls the live CloudVision snapshot (~10s); the watermarks are adjustable sliders and the gating
// recomputes instantly client-side via the SAME @radar/shed functions the (future) feed-pusher uses.
import { useEffect, useRef, useState } from 'react';
import { shedFraction, shedState, type ShedState } from '@radar/shed';
import { api, ApiError } from '../api/client';
import type { ShedSignalsResponse, ShedSignalIsp } from '../api/types';

const POLL_MS = 10_000;

type Wm = { low: number; high: number };

const STATE_LABEL: Record<ShedState, string> = { serve: 'serve', partial: 'partial shed', shed: 'full shed', 'no-data': 'no data' };
const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`);
const gbps = (bps: number | null): string => (bps === null ? '—' : `${(bps / 1e9).toFixed(bps >= 1e10 ? 0 : 1)}G`);

/** One utilisation cell: a capacity bar coloured by shed state, with a shed-% badge when in/above band. */
function UtilCell({ util, wm, active, capacityBps }: { util: number | null; wm: Wm; active: boolean; capacityBps: number | null }) {
  if (!active) return <td className="shed-cell muted" title="No active PNI in this datacentre">— no PNI</td>;
  const st = shedState(util, wm);
  const frac = shedFraction(util, wm.low, wm.high);
  return (
    <td className={`shed-cell shed-${st}`}>
      <div className="shed-bar-wrap" title={capacityBps ? `capacity ${gbps(capacityBps)}` : undefined}>
        <div className="shed-bar" style={{ width: `${Math.min(100, util ?? 0)}%` }} />
        {/* watermark ticks */}
        <span className="shed-tick low" style={{ left: `${wm.low}%` }} />
        <span className="shed-tick high" style={{ left: `${wm.high}%` }} />
      </div>
      <div className="shed-cell-num">
        <b>{pct(util)}</b>
        {frac !== null && frac > 0 && <span className="shed-badge">shed {Math.round(frac * 100)}%</span>}
      </div>
    </td>
  );
}

export function ShedSignals() {
  const [data, setData] = useState<ShedSignalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wm, setWm] = useState<Record<string, Wm>>({});
  // Keep the freshest watermark map available to the poll without re-subscribing.
  const wmSeeded = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await api.shedSignals();
        if (!alive) return;
        setData(res);
        setError(null);
        // Seed the sliders from the default policy ONCE, so live polling never clobbers user edits.
        if (!wmSeeded.current) {
          const seed: Record<string, Wm> = {};
          for (const w of res.defaultWatermarks) seed[w.id] = { low: w.low, high: w.high };
          setWm(seed);
          wmSeeded.current = true;
        }
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load shed signals.');
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error) return <div className="notice error">{error}</div>;
  if (!data) return <div className="card"><p className="muted">Loading shed signals…</p></div>;

  const setWatermark = (id: string, patch: Partial<Wm>) =>
    setWm((prev) => {
      const cur = prev[id] ?? { low: 60, high: 80 };
      const next = { ...cur, ...patch };
      // Keep low < high (clamp on collision).
      if (next.low >= next.high) {
        if (patch.low !== undefined) next.low = Math.max(0, next.high - 1);
        if (patch.high !== undefined) next.high = Math.min(100, next.low + 1);
      }
      return { ...prev, [id]: next };
    });
  const wmFor = (isp: ShedSignalIsp): Wm => wm[isp.id] ?? isp.watermark;

  // Reset the sliders to the mathematically-derived optimal policy (capacity-scaled headroom +
  // stability-sized band) served by the backend.
  const resetToOptimal = () => {
    const seed: Record<string, Wm> = {};
    for (const d of data.defaultWatermarks) seed[d.id] = { low: d.low, high: d.high };
    setWm(seed);
  };
  const dirty = data.defaultWatermarks.some((d) => { const c = wm[d.id]; return !!c && (c.low !== d.low || c.high !== d.high); });

  return (
    <div className="shed-signals">
      <div className="section-head" style={{ alignItems: 'baseline', gap: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>Shed signals → NS1 <span className="badge">DRY-RUN · READ-ONLY</span></h3>
        <span className="muted" style={{ fontSize: '0.78rem' }}>
          {data.connected
            ? `Live CloudVision · ${data.provenance.observedAt ? new Date(data.provenance.observedAt).toLocaleTimeString() : '—'}`
            : 'CloudVision not connected — utilisation unavailable'}
        </span>
        <button className="ghost" style={{ marginLeft: 'auto', fontSize: '0.76rem' }} disabled={!dirty} onClick={resetToOptimal}
          title="Reset every watermark to the derived optimal (capacity-scaled headroom + stability-sized band)">
          Reset to optimal
        </button>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
        Per-ISP (incl. INEX) egress utilisation per datacentre, with the <span className="mono">shed_load</span> gating RADAR
        <b> would</b> feed to NS1. Drag a watermark to see the gating recompute against the live load. Nothing is sent to NS1.
      </p>

      {!data.connected && <div className="notice warn">CloudVision telemetry is not connected — the grid shows the ISP/DC structure and watermark policy, but no live utilisation.</div>}

      <div className="table-scroll">
        <table className="shed-table">
          <thead>
            <tr>
              <th>ISP</th>
              {data.datacentres.map((dc) => <th key={dc.id}>{dc.name}</th>)}
              <th title="Combined across the ISP's PNIs — the feed for the 180s apex spill">Combined feed</th>
              <th>Gating</th>
              <th style={{ minWidth: '11rem' }}>Watermarks (low / high %)</th>
            </tr>
          </thead>
          <tbody>
            {data.isps.map((isp) => {
              const w = wmFor(isp);
              const combinedState = shedState(isp.combined.utilisationPercent, w);
              const combinedFrac = shedFraction(isp.combined.utilisationPercent, w.low, w.high);
              return (
                <tr key={isp.id}>
                  <td>
                    <b>{isp.name}</b>
                    {isp.asn && <span className="mono muted" style={{ fontSize: '0.72rem' }}> AS{isp.asn}</span>}
                    {isp.viaInex && <div className="mono muted" style={{ fontSize: '0.68rem' }}>rides INEX</div>}
                    {isp.isInex && <div className="mono muted" style={{ fontSize: '0.68rem' }}>shared IX</div>}
                  </td>
                  {data.datacentres.map((dc) => {
                    const cell = isp.cells.find((c) => c.dc === dc.id)!;
                    return <UtilCell key={dc.id} util={cell.utilisationPercent} wm={w} active={cell.active} capacityBps={cell.capacityBps} />;
                  })}
                  <UtilCell util={isp.combined.utilisationPercent} wm={w} active capacityBps={isp.combined.capacityBps} />
                  <td>
                    <span className={`shed-pill shed-${combinedState}`}>{STATE_LABEL[combinedState]}</span>
                    {combinedFrac !== null && combinedFrac > 0 && <div className="mono" style={{ fontSize: '0.72rem' }}>drop {Math.round(combinedFrac * 100)}% of queries</div>}
                  </td>
                  <td>
                    <label className="shed-slider">
                      <span className="mono muted">low {w.low}</span>
                      <input type="range" min={0} max={100} value={w.low} onChange={(e) => setWatermark(isp.id, { low: Number(e.target.value) })} />
                    </label>
                    <label className="shed-slider">
                      <span className="mono muted">high {w.high}</span>
                      <input type="range" min={0} max={100} value={w.high} onChange={(e) => setWatermark(isp.id, { high: Number(e.target.value) })} />
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: '0.72rem' }}>
        Gating mirrors NS1 <span className="mono">shed_load</span>: below the low watermark the Réalta answer is served in full; between low and high a rising
        fraction of queries is dropped (spilled to commercial CDNs); at/above high it is fully shed. Watermark edits are local (what-if) and are not persisted.
      </p>
    </div>
  );
}

// Shed Signals — a realtime per-(ISP × datacentre) egress-utilisation grid overlaid with the NS1
// shed_load gating RADAR WOULD feed to NS1. Read-only / dry-run: nothing is sent to NS1. Utilisation
// polls the live CloudVision snapshot (~10s); the watermarks are adjustable sliders and the gating
// recomputes instantly client-side via the SAME @radar/shed functions the (future) feed-pusher uses.
import { useEffect, useRef, useState } from 'react';
import { shedFraction, shedState, type ShedState } from '@radar/shed';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { ShedSignalsResponse, ShedSignalIsp } from '../api/types';

const POLL_MS = 10_000;

// TTL lever — a livetest candidate we flip between 180s and 30s to demonstrate R_max = H/TTL.
// Guarded by the NS1 write path (allow-listed to livetest, never a production record).
const TTL_ZONE = 'livetest.rte.ie';
const TTL_DOMAIN = 'shed.livetest.rte.ie';
const TTL_TARGET = 'target.example.com';

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
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('ns1.record.create');
  const [data, setData] = useState<ShedSignalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wm, setWm] = useState<Record<string, Wm>>({});
  const [ttlBusy, setTtlBusy] = useState<number | null>(null);
  const [ttlMsg, setTtlMsg] = useState<string | null>(null);
  const [ttlErr, setTtlErr] = useState<string | null>(null);
  const [currentTtl, setCurrentTtl] = useState<number | null>(null);
  // After a TTL change, the OLD cached generation keeps being served until it expires — up to the OLD
  // TTL. `drain` tracks that window so we can show when the new TTL is valid everywhere.
  const [drain, setDrain] = useState<{ newTtl: number; oldTtl: number; at: number } | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  // Keep the freshest watermark map available to the poll without re-subscribing.
  const wmSeeded = useRef(false);

  // Read the candidate's current TTL so the first drain window uses the real prior value.
  useEffect(() => {
    if (!canWrite) return;
    let alive = true;
    api.record(TTL_ZONE, TTL_DOMAIN, 'CNAME')
      .then((r) => { const t = Number((r.record as { ttl?: unknown } | undefined)?.ttl); if (alive && Number.isFinite(t)) setCurrentTtl(t); })
      .catch(() => { /* record may not exist yet */ });
    return () => { alive = false; };
  }, [canWrite]);

  // Tick once a second only while a drain window is open, to advance the progress bar.
  useEffect(() => {
    if (!drain) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [drain]);

  // Flip the livetest candidate's TTL via the guarded write path (create/apply upserts the record).
  async function applyTtl(ttl: number) {
    setTtlBusy(ttl); setTtlErr(null);
    const oldTtl = currentTtl ?? (ttl === 30 ? 180 : 30); // best guess if we couldn't read it
    try {
      await api.recordApply({ zone: TTL_ZONE, domain: TTL_DOMAIN, type: 'CNAME', answers: [TTL_TARGET], ttl });
      setCurrentTtl(ttl);
      setTtlMsg(`${TTL_DOMAIN} → TTL ${ttl}s. R_max now ≈ ${(90 / ttl).toFixed(2)} %/s.`);
      setDrain({ newTtl: ttl, oldTtl, at: Date.now() });
      setNowMs(Date.now());
    } catch (e) {
      setTtlErr(e instanceof ApiError ? `${e.code}: ${e.message}` : 'TTL change failed.');
    } finally {
      setTtlBusy(null);
    }
  }

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

  // Progress of the old-TTL cache draining after a change (100% ⇒ the new TTL is valid everywhere).
  const drainInfo = drain
    ? (() => {
        const elapsed = Math.max(0, (nowMs - drain.at) / 1000);
        return {
          pct: Math.min(100, (elapsed / drain.oldTtl) * 100),
          remaining: Math.max(0, Math.ceil(drain.oldTtl - elapsed)),
          done: elapsed >= drain.oldTtl,
          validFrom: new Date(drain.at + drain.oldTtl * 1000).toLocaleTimeString(),
        };
      })()
    : null;

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

      {canWrite && (
        <div className="notice info" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 20rem' }}>
            <b>TTL lever</b> — the controllable ramp is <span className="mono">R_max = H / TTL</span>, so a shorter TTL lets the reactive loop
            catch steeper ramps. Flip the guarded <span className="mono">livetest</span> candidate <span className="mono">{TTL_DOMAIN}</span> to try it
            (never touches a production record; requires NS1 writes enabled).
          </span>
          <button className="ghost" disabled={ttlBusy !== null} onClick={() => applyTtl(30)}>{ttlBusy === 30 ? 'Setting…' : 'Set TTL 30s'}</button>
          <button className="ghost" disabled={ttlBusy !== null} onClick={() => applyTtl(180)}>{ttlBusy === 180 ? 'Reverting…' : 'Revert to 180s'}</button>
          {ttlMsg && <span className="mono" style={{ color: 'var(--ok)', flexBasis: '100%' }}>{ttlMsg}</span>}
          {ttlErr && <span className="mono" style={{ color: 'var(--danger)', flexBasis: '100%' }}>{ttlErr}</span>}
          {drain && drainInfo && (
            <div style={{ flexBasis: '100%' }}>
              <div className="ttl-drain-wrap">
                <div className={`ttl-drain-bar${drainInfo.done ? ' done' : ''}`} style={{ width: `${drainInfo.pct}%` }} />
              </div>
              <div className="mono muted" style={{ fontSize: '0.72rem', marginTop: '0.25rem' }}>
                {drainInfo.done
                  ? `✓ ${drain.newTtl}s TTL now in effect everywhere — the old ${drain.oldTtl}s caches have drained.`
                  : `Old ${drain.oldTtl}s caches draining — ${drain.newTtl}s TTL valid everywhere in ${drainInfo.remaining}s (≈ ${drainInfo.validFrom}). Resolvers cached before the change still serve the old TTL until then.`}
              </div>
            </div>
          )}
        </div>
      )}

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

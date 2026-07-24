// DC Bandwidth — a realtime roll-up of delivery bandwidth for the Network Telemetry page:
//   1. Citywest total and Parkwest total (each DC's total delivery egress),
//   2. the realtime bandwidth of each individual PNI (and the shared INEX link),
//   3. the total across all PNIs.
// Egress (primaryBps) is the delivery direction. Values refresh on the page's ~10s CloudVision poll.
import { useEffect, useMemo, useRef, useState } from 'react';
import { DATACENTRES, type DcId } from '@radar/shed';
import { nextUtilLevel, utilClass, type UtilLevel } from '../network/util-level';
import { api } from '../api/client';
import type { NetworkInterface } from '../api/types';

// Signed % difference between two bandwidths, relative to the LARGER side (0–100%; sign: + = b higher).
function diffOf(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  const hi = Math.max(a, b);
  const mag = hi > 0 ? ((hi - Math.min(a, b)) / hi) * 100 : 0;
  return b >= a ? mag : -mag;
}

const G = 1e9;
const MAX_POINTS = 90; // ~15 min of history at the ~10s poll (well over the 5-min minimum)
const gbps = (bps: number | null | undefined): string => (bps == null ? '—' : `${(bps / G).toFixed(1)}`);

/** A wide inline sparkline of the paired-link difference over time, with a light-green "fully balanced"
 *  reference line at 0 so you can see whether the imbalance is converging toward it or drifting away. */
function Sparkline({ data, width = 220, height = 28 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return <span className="muted" style={{ fontSize: '0.7rem' }}>collecting…</span>;
  const lo = Math.min(0, ...data);
  const hi = Math.max(0, ...data);
  const span = hi - lo || 1;
  const y = (v: number) => height - ((v - lo) / span) * height;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * width).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = data[data.length - 1] ?? 0;
  const cls = Math.abs(last) >= 15 ? 'spark-hot' : Math.abs(last) >= 5 ? 'spark-warm' : 'spark-ok';
  return (
    <svg width={width} height={height} className="sparkline" role="img" aria-label="difference trend">
      {/* fully-balanced (0%) reference line */}
      <line x1="0" y1={y(0)} x2={width} y2={y(0)} className="spark-zero" />
      <polyline points={pts} className={`spark-line ${cls}`} fill="none" />
    </svg>
  );
}
const dcNameOf = (deviceId: string): string => DATACENTRES.find((d) => d.deviceId === deviceId)?.name ?? deviceId;
const isPni = (i: NetworkInterface) => i.linkType === 'PRIVATE_PEERING';
const isIx = (i: NetworkInterface) => i.linkType === 'IX_PEERING';
// Eyeball / audience ISPs whose PNIs carry OTT delivery. An allow-list, so ONLY genuine eyeball
// networks appear — transit, cloud peers (Microsoft), router↔switch uplinks, inter-DC/core links
// and anything a greedy description parse mislabelled as PRIVATE_PEERING are all excluded.
const EYEBALL = /\b(eir|eircom|vodafone|three|sky|virgin|liberty|digiweb|magnet|imagine|pure ?telecom|bt)\b/i;
const isEyeballPni = (i: NetworkInterface) => isPni(i) && EYEBALL.test(i.provider ?? i.name);

export function DcBandwidth({ interfaces }: { interfaces: NetworkInterface[] }) {
  const [focus, setFocus] = useState<'' | DcId>(''); // '' = both DCs; else focus one

  // Delivery links = eyeball-ISP PNIs + the internet exchange (INEX). memberOf === null so LAG
  // members aren't double-counted. Only genuine eyeball networks: router uplinks, inter-DC/core
  // links, transit and cloud peers are excluded by the eyeball allow-list (INEX is kept as an IX).
  const delivery = interfaces.filter((i) => i.memberOf === null && (isEyeballPni(i) || isIx(i)));
  const sum = (list: NetworkInterface[]) => (list.some((i) => i.primaryBps !== null) ? list.reduce((s, i) => s + (i.primaryBps ?? 0), 0) : null);

  // Hysteretic utilisation colour level per interface (amber ≥60% / red ≥80%, 55/75 release) — the SAME
  // alerts as the main Network Telemetry page. Advanced once per poll, remembered across polls in a ref.
  const levelsRef = useRef<Map<string, UtilLevel>>(new Map());
  const levelByKey = useMemo(() => {
    const next = new Map<string, UtilLevel>();
    for (const i of interfaces) {
      const key = `${i.deviceId}::${i.name}`;
      next.set(key, nextUtilLevel(i.utilisationPercent, levelsRef.current.get(key) ?? 'ok'));
    }
    levelsRef.current = next;
    return next;
  }, [interfaces]);

  const dcTotal = (dcId: string) => {
    const dev = DATACENTRES.find((d) => d.id === dcId)?.deviceId;
    return sum(delivery.filter((i) => i.deviceId === dev));
  };
  // The per-link table + its totals honour the DC focus filter; the DC total cards always show both.
  const focusDevice = DATACENTRES.find((d) => d.id === focus)?.deviceId ?? null;
  const scoped = focus ? delivery.filter((i) => i.deviceId === focusDevice) : delivery;
  // Stable alphabetical order (provider, then DC) — the table does NOT reshuffle as live traffic
  // changes, so a given ISP keeps its row instead of jumping to the top when it serves most.
  const byName = (a: NetworkInterface, b: NetworkInterface) => (a.provider ?? a.name).localeCompare(b.provider ?? b.name) || dcNameOf(a.deviceId).localeCompare(dcNameOf(b.deviceId));
  const pnis = scoped.filter(isPni).sort(byName);
  const ixs = scoped.filter(isIx).sort(byName);
  const totalPnis = sum(pnis);
  const totalIx = sum(ixs);
  const grand = sum(scoped);

  // Paired links: the same provider at BOTH datacentres (Eir CW vs Eir PW, INEX CW vs INEX PW, …),
  // with the % difference between the two sides. Always over both DCs, independent of the focus filter.
  const dev = (id: DcId) => DATACENTRES.find((d) => d.id === id)?.deviceId;
  const providerBps = (provider: string, dcId: DcId) => sum(delivery.filter((i) => (i.provider ?? i.name) === provider && i.deviceId === dev(dcId)));
  const pairs = [...new Set(delivery.map((i) => i.provider ?? i.name))]
    .map((provider) => {
      const cw = providerBps(provider, 'citywest');
      const pw = providerBps(provider, 'parkwest');
      const ix = delivery.some((i) => (i.provider ?? i.name) === provider && isIx(i));
      return { provider, cw, pw, diff: diffOf(cw, pw), ix };
    })
    .filter((x) => x.cw !== null && x.pw !== null) // only providers present at both DCs
    .sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));

  // Accumulate the per-pair difference over the page's polls to drive the trend sparkline.
  const [history, setHistory] = useState<Record<string, number[]>>({});
  useEffect(() => {
    setHistory((prev) => {
      const next: Record<string, number[]> = { ...prev };
      for (const pr of pairs) if (pr.diff !== null) next[pr.provider] = (next[pr.provider] ?? []).concat(pr.diff).slice(-MAX_POINTS);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interfaces]);

  // Seed the trend from the backend history on mount, so it's populated from FIRST access (not only
  // built up live as you watch).
  useEffect(() => {
    let alive = true;
    api.ottHistory(MAX_POINTS).then((res) => {
      if (!alive) return;
      const seed: Record<string, number[]> = {};
      for (const pt of res.items) for (const [provider, v] of Object.entries(pt.byProvider)) {
        const d = diffOf(v.citywest, v.parkwest);
        if (d !== null) (seed[provider] ??= []).push(d);
      }
      setHistory((prev) => {
        const next = { ...prev };
        for (const [k, arr] of Object.entries(seed)) if (!next[k] || next[k].length < arr.length) next[k] = arr.slice(-MAX_POINTS);
        return next;
      });
    }).catch(() => { /* trend history is best-effort */ });
    return () => { alive = false; };
  }, []);

  const row = (i: NetworkInterface) => {
    const lvl = levelByKey.get(`${i.deviceId}::${i.name}`) ?? 'ok';
    return (
      <tr key={`${i.deviceId}::${i.name}`}>
        <td><b>{i.provider ?? i.name}</b>{i.provider && <span className="mono muted" style={{ fontSize: '0.72rem' }}> {i.name}</span>}</td>
        <td className="muted">{dcNameOf(i.deviceId)}</td>
        <td>{isIx(i) ? <span className="badge neutral">IX</span> : <span className="badge info">PNI</span>}</td>
        <td className="mono" style={{ textAlign: 'right' }}>{gbps(i.speedBps)} Gb/s</td>
        <td className={`mono ${utilClass(lvl) ?? ''}`} style={{ textAlign: 'right' }}>
          <b>{gbps(i.primaryBps)}</b> Gb/s{i.utilisationPercent != null && <span className="muted"> · {i.utilisationPercent.toFixed(0)}%</span>}
        </td>
      </tr>
    );
  };

  return (
    <div className="dc-bandwidth">
      <div className="section-head" style={{ alignItems: 'baseline', gap: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>OTT delivery bandwidth</h2>
        <span className="muted" style={{ fontSize: '0.78rem' }}>egress to eyeball networks · live · ~10s</span>
        <div className="rv-viewtoggle" role="tablist" style={{ marginLeft: 'auto' }}>
          <button role="tab" aria-selected={focus === ''} className={focus === '' ? 'on' : ''} onClick={() => setFocus('')}>Both</button>
          {DATACENTRES.map((d) => (
            <button key={d.id} role="tab" aria-selected={focus === d.id} className={focus === d.id ? 'on' : ''} onClick={() => setFocus(d.id)}>{d.name}</button>
          ))}
        </div>
      </div>

      {/* 1. Per-datacentre totals */}
      <div className="grid cols-2" style={{ marginBottom: '1rem' }}>
        {DATACENTRES.map((d) => (
          <div className={`card${focus === d.id ? ' dc-focus' : ''}`} key={d.id}>
            <div className="muted" style={{ fontSize: '0.8rem' }}>{d.name} total</div>
            <div className="stat">{gbps(dcTotal(d.id))} <span style={{ fontSize: '1rem', fontWeight: 400 }} className="muted">Gb/s</span></div>
          </div>
        ))}
      </div>

      {/* 1b. Paired links (same provider CW vs PW) + the % difference */}
      {pairs.length > 0 && (
        <div className="table-scroll" style={{ marginBottom: '1rem' }}>
          <table className="shed-table">
            <thead>
              <tr><th>Paired link</th><th style={{ textAlign: 'right' }}>Citywest</th><th style={{ textAlign: 'right' }}>Parkwest</th><th style={{ textAlign: 'right' }} title="Difference relative to the larger side (0–100%)">Difference</th><th>Trend</th></tr>
            </thead>
            <tbody>
              {pairs.map((pr) => {
                const hot = pr.diff !== null && Math.abs(pr.diff) >= 15;
                return (
                  <tr key={pr.provider}>
                    <td><b>{pr.provider}</b>{pr.ix && <span className="badge neutral" style={{ marginLeft: '0.3rem' }}>IX</span>}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{gbps(pr.cw)} G</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{gbps(pr.pw)} G</td>
                    <td className={`mono ${hot ? 'shed-shed' : pr.diff !== null && Math.abs(pr.diff) >= 5 ? 'shed-partial' : 'shed-serve'}`} style={{ textAlign: 'right' }}>
                      <b>{pr.diff === null ? '—' : Math.abs(pr.diff) < 0.5 ? 'balanced' : `${pr.diff > 0 ? 'PW' : 'CW'} +${Math.abs(pr.diff).toFixed(0)}%`}</b>
                    </td>
                    <td><Sparkline data={history[pr.provider] ?? []} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 2. Each PNI (+ INEX) in realtime */}
      <div className="table-scroll">
        <table className="shed-table">
          <thead>
            <tr><th>Link</th><th>Datacentre</th><th>Type</th><th style={{ textAlign: 'right' }}>Capacity</th><th style={{ textAlign: 'right' }}>Bandwidth (util)</th></tr>
          </thead>
          <tbody>
            {pnis.map(row)}
            {/* PNI subtotal — directly under the PNIs */}
            {pnis.length > 0 && (
              <tr className="dc-subtotal"><td colSpan={4}><b>Total of PNIs</b></td><td className="mono" style={{ textAlign: 'right' }}><b>{gbps(totalPnis)} Gb/s</b></td></tr>
            )}
            {ixs.length > 0 && (
              <tr className="dc-sep"><td colSpan={5}>Internet Exchange (IX)</td></tr>
            )}
            {ixs.map(row)}
            {/* IX subtotal — directly under the IX links */}
            {ixs.length > 0 && (
              <tr className="dc-subtotal"><td colSpan={4} className="muted">Total INEX</td><td className="mono muted" style={{ textAlign: 'right' }}>{gbps(totalIx)} Gb/s</td></tr>
            )}
            {scoped.length === 0 && <tr><td colSpan={5} className="muted">No delivery links found (CloudVision not connected, or no PNI/IX interfaces).</td></tr>}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Grand total (PNI + IX)</td>
              <td className="mono" style={{ textAlign: 'right' }}>{gbps(grand)} Gb/s</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

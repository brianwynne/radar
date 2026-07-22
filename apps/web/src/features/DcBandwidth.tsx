// DC Bandwidth — a realtime roll-up of delivery bandwidth for the Network Telemetry page:
//   1. Citywest total and Parkwest total (each DC's total delivery egress),
//   2. the realtime bandwidth of each individual PNI (and the shared INEX link),
//   3. the total across all PNIs.
// Egress (primaryBps) is the delivery direction. Values refresh on the page's ~10s CloudVision poll.
import { useState } from 'react';
import { DATACENTRES, isDeliveryLink, type DcId } from '@radar/shed';
import type { NetworkInterface } from '../api/types';

const G = 1e9;
const gbps = (bps: number | null): string => (bps === null ? '—' : `${(bps / G).toFixed(1)}`);
const dcNameOf = (deviceId: string): string => DATACENTRES.find((d) => d.deviceId === deviceId)?.name ?? deviceId;
const isPni = (i: NetworkInterface) => i.linkType === 'PRIVATE_PEERING';
const isIx = (i: NetworkInterface) => i.linkType === 'IX_PEERING';

export function DcBandwidth({ interfaces }: { interfaces: NetworkInterface[] }) {
  const [focus, setFocus] = useState<'' | DcId>(''); // '' = both DCs; else focus one

  // Delivery links = the PNI + IX Port-Channels (memberOf === null so we don't double-count members),
  // excluding non-delivery cloud peers (e.g. Microsoft) even though they are PNIs.
  const delivery = interfaces.filter((i) => isDeliveryLink(i.linkType, i.provider) && i.memberOf === null);
  const sum = (list: NetworkInterface[]) => (list.some((i) => i.primaryBps !== null) ? list.reduce((s, i) => s + (i.primaryBps ?? 0), 0) : null);

  const dcTotal = (dcId: string) => {
    const dev = DATACENTRES.find((d) => d.id === dcId)?.deviceId;
    return sum(delivery.filter((i) => i.deviceId === dev));
  };
  // The per-link table + its totals honour the DC focus filter; the DC total cards always show both.
  const focusDevice = DATACENTRES.find((d) => d.id === focus)?.deviceId ?? null;
  const scoped = focus ? delivery.filter((i) => i.deviceId === focusDevice) : delivery;
  const pnis = scoped.filter(isPni).sort((a, b) => (b.primaryBps ?? 0) - (a.primaryBps ?? 0));
  const ixs = scoped.filter(isIx).sort((a, b) => (b.primaryBps ?? 0) - (a.primaryBps ?? 0));
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
      const diff = cw !== null && pw !== null && cw + pw > 0 ? ((pw - cw) / ((cw + pw) / 2)) * 100 : null;
      const ix = delivery.some((i) => (i.provider ?? i.name) === provider && isIx(i));
      return { provider, cw, pw, diff, ix };
    })
    .filter((x) => x.cw !== null && x.pw !== null) // only providers present at both DCs
    .sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));

  const row = (i: NetworkInterface) => (
    <tr key={`${i.deviceId}::${i.name}`}>
      <td><b>{i.provider ?? i.name}</b>{i.provider && <span className="mono muted" style={{ fontSize: '0.72rem' }}> {i.name}</span>}</td>
      <td className="muted">{dcNameOf(i.deviceId)}</td>
      <td>{isIx(i) ? <span className="badge neutral">IX</span> : <span className="badge info">PNI</span>}</td>
      <td className="mono" style={{ textAlign: 'right' }}><b>{gbps(i.primaryBps)}</b> Gb/s</td>
    </tr>
  );

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
              <tr><th>Paired link</th><th style={{ textAlign: 'right' }}>Citywest</th><th style={{ textAlign: 'right' }}>Parkwest</th><th style={{ textAlign: 'right' }} title="Difference between the two sides, relative to their mean">Difference</th></tr>
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
            <tr><th>Link</th><th>Datacentre</th><th>Type</th><th style={{ textAlign: 'right' }}>Bandwidth</th></tr>
          </thead>
          <tbody>
            {pnis.map(row)}
            {pnis.length > 0 && ixs.length > 0 && (
              <tr className="dc-sep"><td colSpan={4}>Internet Exchange (IX)</td></tr>
            )}
            {ixs.map(row)}
            {scoped.length === 0 && <tr><td colSpan={4} className="muted">No delivery links found (CloudVision not connected, or no PNI/IX interfaces).</td></tr>}
          </tbody>
          {/* 3. Totals */}
          <tfoot>
            <tr>
              <td colSpan={3}><b>Total of PNIs</b></td>
              <td className="mono" style={{ textAlign: 'right' }}><b>{gbps(totalPnis)} Gb/s</b></td>
            </tr>
            {ixs.length > 0 && (
              <tr>
                <td colSpan={3} className="muted">Total INEX</td>
                <td className="mono muted" style={{ textAlign: 'right' }}>{gbps(totalIx)} Gb/s</td>
              </tr>
            )}
            <tr>
              <td colSpan={3} className="muted">Grand total (PNI + IX)</td>
              <td className="mono muted" style={{ textAlign: 'right' }}>{gbps(grand)} Gb/s</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// DC Balancer — dry-run control surface for balancing delivery across the four RTÉ-CDN pools
// (Mam, Dad, Citywest, Parkwest) via Cloudflare Load Balancing pool weights, to EQUALISE utilisation.
// READ-ONLY / dry-run: no Cloudflare write key is configured, so nothing is pushed — this previews the
// weights RADAR WOULD apply. Only RELATIVE capacity matters (CW/PW ≈ 8× Mam/Dad): the recommended
// weight for equal utilisation is each pool's share of total healthy capacity, and "balance" is simply
// each pool's observed load share ÷ its capacity share (1.0 = perfectly balanced). A failed cache lowers
// a pool's healthy capacity → its weight → shifts traffic away. A toggle reverts to the predefined weights.
import { useEffect, useMemo, useState } from 'react';
import { balanceForEqualUtilisation, rebalancePair, BALANCE_POOLS, type BalancePool } from '@radar/shed';
import { api, ApiError } from '../api/client';
import type { CloudflareLoadBalancer, CloudflarePool, ShedSignalsResponse } from '../api/types';

const matches = (name: string | null | undefined, subs: readonly string[]): boolean =>
  !!name && subs.some((s) => name.toLowerCase().includes(s));

const pctOrDash = (v: number | null): string => (v === null ? '—' : `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`);

export function DcBalancer() {
  const [lbs, setLbs] = useState<CloudflareLoadBalancer[] | null>(null);
  const [pools, setPools] = useState<CloudflarePool[]>([]);
  const [shed, setShed] = useState<ShedSignalsResponse | null>(null); // live per-DC (CW/PW) utilisation
  const [error, setError] = useState<string | null>(null);
  const [dynamicOn, setDynamicOn] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([api.cloudflareLoadBalancers(), api.cloudflarePools(), api.shedSignals()])
      .then(([l, p, s]) => { if (alive) { setLbs(l.items); setPools(p.items); setShed(s); } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load Cloudflare data.'); });
    void load();
    const t = setInterval(load, 10_000); // keep the CW↔PW utilisation live
    return () => { alive = false; clearInterval(t); };
  }, []);

  // The delivery LB = the one whose pools best match the four policy pools.
  const lb = useMemo(() => {
    if (!lbs?.length) return null;
    const score = (x: CloudflareLoadBalancer) => BALANCE_POOLS.filter((bp) => x.defaultPools.some((sp) => matches(sp.poolName, bp.match))).length;
    return [...lbs].sort((a, b) => score(b) - score(a))[0] ?? null;
  }, [lbs]);

  const outcome = useMemo(() => {
    const input: BalancePool[] = BALANCE_POOLS.map((bp) => {
      // Current weight = the weight Cloudflare reports for this pool (same as the Load Balancing page).
      const steered = lb?.defaultPools.find((sp) => matches(sp.poolName, bp.match)) ?? null;
      const cfPool = pools.find((p) => matches(p.name, bp.match)) ?? null;
      const capacity = (cfPool ? cfPool.healthyOrigins : bp.caches) * bp.cacheGbps;
      const share = lb?.observed?.byPool.find((b) => matches(b.key, bp.match))?.sharePercent ?? null;
      return { id: bp.id, name: bp.name, capacity, load: share, currentWeight: steered?.weight ?? null };
    });
    return balanceForEqualUtilisation(input);
  }, [lb, pools]);

  // Live Citywest ↔ Parkwest rebalance: use the per-DC network utilisation to shift weight between the
  // CW and PW pools ONLY (Mam/Dad untouched), driving their utilisation toward equal.
  const cwPw = useMemo(() => {
    const util = (id: string) => shed?.datacentres.find((d) => d.id === id)?.utilisationPercent ?? null;
    const weight = (id: string) => outcome.pools.find((p) => p.id === id)?.currentWeight ?? null;
    const cwUtil = util('citywest'), pwUtil = util('parkwest'), cwW = weight('citywest'), pwW = weight('parkwest');
    const reb = cwW !== null && pwW !== null
      ? rebalancePair({ utilisationPercent: cwUtil, weight: cwW }, { utilisationPercent: pwUtil, weight: pwW })
      : null;
    return { cwUtil, pwUtil, cwW, pwW, reb };
  }, [shed, outcome]);

  if (error) return <div className="notice error">{error}</div>;
  if (!lbs) return <div className="card"><p className="muted">Loading Cloudflare load balancers…</p></div>;

  const meta = (id: string) => BALANCE_POOLS.find((p) => p.id === id)!;
  const cfPoolFor = (id: string) => pools.find((p) => matches(p.name, meta(id).match)) ?? null;
  const result = outcome;
  const target = result.targetUtilisationPercent;
  // Balance index = load share ÷ capacity share (= util / target). 1.0 = balanced; > 1 over-subscribed.
  const indexOf = (util: number | null): number | null => (util !== null && target && target > 0 ? util / target : null);
  const worst = result.pools.map((p) => ({ id: p.id, ix: indexOf(p.utilisationPercent) })).filter((x) => x.ix !== null).sort((a, b) => (b.ix as number) - (a.ix as number))[0];

  return (
    <div className="dc-balancer">
      <div className="section-head" style={{ alignItems: 'baseline', gap: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>DC balancer → Cloudflare <span className="badge">DRY-RUN · READ-ONLY</span></h3>
        <span className="muted" style={{ fontSize: '0.78rem' }}>{lb ? `LB: ${lb.name} · ${lb.steeringPolicy} steering` : 'No matching load balancer found'}</span>
        <label className="switch" style={{ marginLeft: 'auto', fontSize: '0.8rem' }}>
          <input type="checkbox" checked={dynamicOn} onChange={(e) => setDynamicOn(e.target.checked)} /> Dynamic balancing
        </label>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
        Balances delivery across the four RTÉ-CDN pools to <b>equalise utilisation</b> — the recommended weight is each pool's
        share of total <b>healthy capacity</b> (only the ratio matters: CW/PW ≈ 8× Mam/Dad).
        {dynamicOn ? ' Dynamic ON — showing the weights RADAR would push.' : ' Dynamic OFF — showing the predefined Cloudflare weights.'}
        {' '}No Cloudflare write key is configured, so <b>nothing is sent</b>.
        {worst && worst.ix && worst.ix > 1.15 && <> Most over-subscribed: <b>{meta(worst.id).name}</b> at {(worst.ix).toFixed(2)}× its capacity share.</>}
      </p>

      {/* Live Citywest ↔ Parkwest balance, driven by the network-utilisation page (CloudVision). */}
      <div className="cwpw-panel">
        <div className="cwpw-head">
          <b>Citywest ↔ Parkwest live balance</b>
          <span className="muted"> — from network utilisation; adjusts only the CW/PW pool weights, Mam/Dad untouched</span>
        </div>
        {cwPw.cwUtil === null || cwPw.pwUtil === null ? (
          <div className="muted" style={{ fontSize: '0.78rem' }}>Network utilisation unavailable (CloudVision not connected).</div>
        ) : (
          <div className="cwpw-grid">
            <div><span className="muted">Citywest util</span><div className="cwpw-num">{cwPw.cwUtil.toFixed(1)}%</div></div>
            <div><span className="muted">Parkwest util</span><div className="cwpw-num">{cwPw.pwUtil.toFixed(1)}%</div></div>
            <div><span className="muted">Imbalance</span><div className={`cwpw-num ${cwPw.reb && Math.abs(cwPw.reb.imbalancePercent ?? 0) >= 10 ? 'cwpw-hot' : ''}`}>{cwPw.reb?.imbalancePercent === null || cwPw.reb === null ? '—' : `${cwPw.reb.imbalancePercent > 0 ? 'PW' : cwPw.reb.imbalancePercent < 0 ? 'CW' : ''} +${Math.abs(cwPw.reb.imbalancePercent).toFixed(1)}%`}</div></div>
            <div>
              <span className="muted">CW weight</span>
              <div className="cwpw-num mono">{cwPw.cwW === null ? '—' : cwPw.cwW}{cwPw.reb && <span className="cwpw-arrow"> → <b>{cwPw.reb.aWeight.toFixed(4)}</b></span>}</div>
            </div>
            <div>
              <span className="muted">PW weight</span>
              <div className="cwpw-num mono">{cwPw.pwW === null ? '—' : cwPw.pwW}{cwPw.reb && <span className="cwpw-arrow"> → <b>{cwPw.reb.bWeight.toFixed(4)}</b></span>}</div>
            </div>
          </div>
        )}
        <div className="muted" style={{ fontSize: '0.7rem', marginTop: '0.35rem' }}>
          Weight shifts toward the cooler DC in proportion to the imbalance, at full Cloudflare weight precision (no % rounding).
          Combined CW+PW weight is preserved. Dry-run — nothing is sent.
        </div>
      </div>

      <div className="table-scroll">
        <table className="shed-table">
          <thead>
            <tr>
              <th>Pool</th><th>Site</th><th>Caches (healthy)</th><th title="Each pool's share of total healthy capacity — only the ratio matters">Capacity share</th>
              <th>Load share</th><th title="Load share ÷ capacity share — 1.0 is balanced, above 1 is carrying more than its capacity">Balance</th>
              <th>Current weight</th><th>{dynamicOn ? 'Recommended weight' : 'Predefined (active)'}</th>
            </tr>
          </thead>
          <tbody>
            {result.pools.map((p) => {
              const m = meta(p.id);
              const cf = cfPoolFor(p.id);
              const ix = indexOf(p.utilisationPercent);
              const st = ix === null ? '' : ix >= 1.5 ? 'shed-shed' : ix >= 1.15 ? 'shed-partial' : 'shed-serve';
              return (
                <tr key={p.id}>
                  <td><b>{m.name}</b></td>
                  <td className="muted">{m.site}</td>
                  <td>{cf ? `${cf.healthyOrigins}/${cf.totalOrigins}` : `${m.caches}`}{cf && cf.healthyOrigins < cf.totalOrigins && <span className="shed-badge" style={{ marginLeft: '0.3rem' }}>degraded</span>}</td>
                  <td className="mono">{result.totalCapacity > 0 ? `${((p.capacity / result.totalCapacity) * 100).toFixed(1)}%` : '—'}</td>
                  <td className="mono">{p.load === null ? '—' : `${p.load.toFixed(0)}%`}</td>
                  <td className={`shed-cell ${st}`}><b>{ix === null ? '—' : `${ix.toFixed(2)}×`}</b></td>
                  <td className="mono">{p.currentWeight === null ? '—' : p.currentWeight}</td>
                  <td className="mono"><b>{dynamicOn ? `${p.recommendedShare.toFixed(0)}%` : (p.currentWeight === null ? '—' : p.currentWeight)}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: '0.72rem' }}>
        Recommended weight = capacity share, which equalises utilisation. A failed cache lowers that pool's healthy capacity (and
        its recommended weight), shifting traffic to the healthy pools. When a Cloudflare write key is provided, "Dynamic balancing"
        will push these weights on a cadence; off reverts to the predefined weights. {pctOrDash(target) !== '—' && <>Balanced target load-share = capacity share.</>}
      </p>
    </div>
  );
}

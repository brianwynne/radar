// DC Balancer — dry-run control surface for balancing delivery across the four RTÉ-CDN pools
// (Mam, Dad, Citywest, Parkwest) via Cloudflare Load Balancing pool weights, to EQUALISE utilisation.
// READ-ONLY / dry-run: no Cloudflare write key is configured, so nothing is pushed — this previews the
// weights RADAR WOULD apply. Only RELATIVE capacity matters (CW/PW ≈ 8× Mam/Dad): the recommended
// weight for equal utilisation is each pool's share of total healthy capacity, and "balance" is simply
// each pool's observed load share ÷ its capacity share (1.0 = perfectly balanced). A failed cache lowers
// a pool's healthy capacity → its weight → shifts traffic away. A toggle reverts to the predefined weights.
import { useEffect, useMemo, useState } from 'react';
import { balanceForEqualUtilisation, BALANCE_POOLS, type BalancePool } from '@radar/shed';
import { api, ApiError } from '../api/client';
import type { CloudflareLoadBalancer, CloudflarePool } from '../api/types';

const matches = (name: string | null | undefined, subs: readonly string[]): boolean =>
  !!name && subs.some((s) => name.toLowerCase().includes(s));

const pctOrDash = (v: number | null): string => (v === null ? '—' : `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`);

export function DcBalancer() {
  const [lbs, setLbs] = useState<CloudflareLoadBalancer[] | null>(null);
  const [pools, setPools] = useState<CloudflarePool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dynamicOn, setDynamicOn] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([api.cloudflareLoadBalancers(), api.cloudflarePools()])
      .then(([l, p]) => { if (alive) { setLbs(l.items); setPools(p.items); } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load Cloudflare data.'); });
    return () => { alive = false; };
  }, []);

  // The delivery LB = the one whose default pools best match the four policy pools.
  const lb = useMemo(() => {
    if (!lbs?.length) return null;
    const score = (x: CloudflareLoadBalancer) => BALANCE_POOLS.filter((bp) => x.defaultPools.some((sp) => matches(sp.poolName, bp.match))).length;
    return [...lbs].sort((a, b) => score(b) - score(a))[0] ?? null;
  }, [lbs]);

  const outcome = useMemo(() => {
    // load = observed traffic share (%), capacity = healthy caches × relative per-cache capacity.
    const input: BalancePool[] = BALANCE_POOLS.map((bp) => {
      const steered = lb?.defaultPools.find((sp) => matches(sp.poolName, bp.match)) ?? null;
      const cfPool = pools.find((p) => matches(p.name, bp.match)) ?? null;
      const healthyCaches = cfPool ? cfPool.healthyOrigins : bp.caches;
      const capacity = healthyCaches * bp.cacheGbps;
      const share = lb?.observed?.byPool.find((b) => matches(b.key, bp.match))?.sharePercent ?? null;
      return { id: bp.id, name: bp.name, capacity, load: share, currentWeight: steered?.weight ?? null };
    });
    return balanceForEqualUtilisation(input);
  }, [lb, pools]);

  if (error) return <div className="notice error">{error}</div>;
  if (!lbs) return <div className="card"><p className="muted">Loading Cloudflare load balancers…</p></div>;

  const meta = (id: string) => BALANCE_POOLS.find((p) => p.id === id)!;
  const cfPoolFor = (id: string) => pools.find((p) => matches(p.name, meta(id).match)) ?? null;
  const target = outcome.targetUtilisationPercent;
  // Balance index = load share ÷ capacity share (= util / target). 1.0 = balanced; > 1 over-subscribed.
  const indexOf = (util: number | null): number | null => (util !== null && target && target > 0 ? util / target : null);
  const worst = outcome.pools.map((p) => ({ id: p.id, ix: indexOf(p.utilisationPercent) })).filter((x) => x.ix !== null).sort((a, b) => (b.ix as number) - (a.ix as number))[0];

  return (
    <div className="dc-balancer">
      <div className="section-head" style={{ alignItems: 'baseline', gap: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>DC balancer → Cloudflare <span className="badge">DRY-RUN · READ-ONLY</span></h3>
        <span className="muted" style={{ fontSize: '0.78rem' }}>{lb ? `LB: ${lb.name}` : 'No matching load balancer found'}</span>
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
            {outcome.pools.map((p) => {
              const m = meta(p.id);
              const cf = cfPoolFor(p.id);
              const activeShare = dynamicOn ? p.recommendedShare : (p.currentWeight !== null ? p.currentWeight * 100 : null);
              const ix = indexOf(p.utilisationPercent);
              const st = ix === null ? '' : ix >= 1.5 ? 'shed-shed' : ix >= 1.15 ? 'shed-partial' : 'shed-serve';
              return (
                <tr key={p.id}>
                  <td><b>{m.name}</b></td>
                  <td className="muted">{m.site}</td>
                  <td>{cf ? `${cf.healthyOrigins}/${cf.totalOrigins}` : `${m.caches}`}{cf && cf.healthyOrigins < cf.totalOrigins && <span className="shed-badge" style={{ marginLeft: '0.3rem' }}>degraded</span>}</td>
                  <td className="mono">{outcome.totalCapacity > 0 ? `${((p.capacity / outcome.totalCapacity) * 100).toFixed(1)}%` : '—'}</td>
                  <td className="mono">{p.load === null ? '—' : `${p.load.toFixed(0)}%`}</td>
                  <td className={`shed-cell ${st}`}><b>{ix === null ? '—' : `${ix.toFixed(2)}×`}</b></td>
                  <td className="mono">{p.currentWeight === null ? '—' : `${(p.currentWeight * 100).toFixed(0)}%`}</td>
                  <td className="mono"><b>{activeShare === null ? '—' : `${activeShare.toFixed(0)}%`}</b></td>
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

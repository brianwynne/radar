// DC Balancer — dry-run control surface for balancing delivery across the four RTÉ-CDN pools
// (Mam, Dad, Citywest, Parkwest) via Cloudflare Load Balancing pool weights, to EQUALISE utilisation.
// READ-ONLY / dry-run: no Cloudflare write key is configured, so nothing is pushed — this previews the
// weights RADAR WOULD apply. Utilisation = (observed traffic share × offered load) ÷ healthy capacity;
// the balanced weights come from the shared @radar/shed solver (weight ∝ healthy capacity). A toggle
// turns dynamic management off (revert to the predefined Cloudflare weights).
import { useEffect, useMemo, useState } from 'react';
import { balanceForEqualUtilisation, BALANCE_POOLS, type BalancePool } from '@radar/shed';
import { api, ApiError } from '../api/client';
import type { CloudflareLoadBalancer, CloudflarePool } from '../api/types';

const matches = (name: string | null | undefined, subs: readonly string[]): boolean =>
  !!name && subs.some((s) => name.toLowerCase().includes(s));

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`);

export function DcBalancer() {
  const [lbs, setLbs] = useState<CloudflareLoadBalancer[] | null>(null);
  const [pools, setPools] = useState<CloudflarePool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dynamicOn, setDynamicOn] = useState(true);
  const [offeredGbps, setOfferedGbps] = useState(500); // operator input — total offered delivery load
  const [cacheGbps, setCacheGbps] = useState<Record<string, number>>(() => Object.fromEntries(BALANCE_POOLS.map((p) => [p.id, p.cacheGbps])));

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
    const input: BalancePool[] = BALANCE_POOLS.map((bp) => {
      const steered = lb?.defaultPools.find((sp) => matches(sp.poolName, bp.match)) ?? null;
      const cfPool = pools.find((p) => matches(p.name, bp.match)) ?? null;
      const healthyCaches = cfPool ? cfPool.healthyOrigins : bp.caches; // failed caches drop capacity
      const capacity = healthyCaches * (cacheGbps[bp.id] ?? bp.cacheGbps);
      const share = lb?.observed?.byPool.find((b) => matches(b.key, bp.match))?.sharePercent ?? null;
      const load = share !== null ? (offeredGbps * share) / 100 : null;
      return { id: bp.id, name: bp.name, capacity, load, currentWeight: steered?.weight ?? null };
    });
    return { result: balanceForEqualUtilisation(input), input };
  }, [lb, pools, offeredGbps, cacheGbps]);

  if (error) return <div className="notice error">{error}</div>;
  if (!lbs) return <div className="card"><p className="muted">Loading Cloudflare load balancers…</p></div>;

  const meta = (id: string) => BALANCE_POOLS.find((p) => p.id === id)!;
  const cfPoolFor = (id: string) => pools.find((p) => matches(p.name, meta(id).match)) ?? null;

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
        Balances delivery across the four RTÉ-CDN pools to <b>equalise utilisation</b> (weight ∝ healthy capacity).
        {dynamicOn
          ? ' Dynamic ON — showing the weights RADAR would push.'
          : ' Dynamic OFF — showing the predefined Cloudflare weights (no rebalancing).'}
        {' '}No Cloudflare write key is configured, so <b>nothing is sent</b>.
      </p>

      <div className="dc-inputs">
        <label className="field" style={{ maxWidth: '14rem' }}>
          <span>Offered delivery load (Gb/s)</span>
          <input type="number" min={0} max={5000} value={offeredGbps} onChange={(e) => setOfferedGbps(Math.max(0, Number(e.target.value)))} className="mono" />
        </label>
        <div className="muted" style={{ fontSize: '0.72rem', alignSelf: 'end' }}>
          Target when balanced: <b>{pct(outcome.result.targetUtilisationPercent)}</b> · current spread: <b>{pct(outcome.result.currentSpreadPercent)}</b>
        </div>
      </div>

      <div className="table-scroll">
        <table className="shed-table">
          <thead>
            <tr>
              <th>Pool</th><th>Site</th><th>Caches (healthy)</th><th>Per-cache Gb/s</th><th>Capacity</th>
              <th>Load</th><th>Utilisation</th><th>Current weight</th><th>{dynamicOn ? 'Recommended weight' : 'Predefined (active)'}</th><th>Projected util</th>
            </tr>
          </thead>
          <tbody>
            {outcome.result.pools.map((p) => {
              const m = meta(p.id);
              const cf = cfPoolFor(p.id);
              const activeShare = dynamicOn ? p.recommendedShare : (p.currentWeight !== null ? p.currentWeight * 100 : null);
              const util = p.utilisationPercent;
              const st = util === null ? '' : util >= 90 ? 'shed-shed' : util >= 75 ? 'shed-partial' : 'shed-serve';
              return (
                <tr key={p.id}>
                  <td><b>{m.name}</b></td>
                  <td className="muted">{m.site}</td>
                  <td>{cf ? `${cf.healthyOrigins}/${cf.totalOrigins}` : `${m.caches}`}{cf && cf.healthyOrigins < cf.totalOrigins && <span className="shed-badge" style={{ marginLeft: '0.3rem' }}>degraded</span>}</td>
                  <td>
                    <input type="number" min={1} max={400} value={cacheGbps[p.id] ?? m.cacheGbps}
                      onChange={(e) => setCacheGbps((prev) => ({ ...prev, [p.id]: Math.max(1, Number(e.target.value)) }))}
                      className="mono" style={{ width: '4.5rem' }} />
                  </td>
                  <td className="mono">{p.capacity} G</td>
                  <td className="mono">{p.load === null ? '—' : `${p.load.toFixed(0)} G`}</td>
                  <td className={`shed-cell ${st}`}><b>{pct(util)}</b></td>
                  <td className="mono">{p.currentWeight === null ? '—' : `${(p.currentWeight * 100).toFixed(0)}%`}</td>
                  <td className="mono"><b>{activeShare === null ? '—' : `${activeShare.toFixed(0)}%`}</b></td>
                  <td className="mono">{dynamicOn ? pct(p.projectedUtilisationPercent) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: '0.72rem' }}>
        Capacity = healthy caches × per-cache Gb/s (both editable — set them to your real cache specs). Balanced weights equalise
        utilisation, so a failed cache lowers a pool's capacity and its weight, shifting traffic to the healthy pools. When a
        Cloudflare write key is provided, "Dynamic balancing" will push these weights on a cadence; off reverts to the predefined weights.
      </p>
    </div>
  );
}

// BGP Intelligence — how RTÉ's prefixes are observed EXTERNALLY via RIPE (RIPEstat + RIS Live),
// read-only. Leads with operational meaning: within seconds an operator sees whether a route looks
// healthy, whether only traffic engineering is affected, whether there's an origin/RPKI problem, or
// whether the monitoring SOURCE itself is unavailable (never shown as a withdrawal). CloudVision
// correlation fields are present but explicitly "not yet available" — RADAR never infers local
// advertisement from RIPE observations.
import { Fragment, useMemo, useState } from 'react';
import { useRipeIntelligence } from '../telemetry/use-ripe-intelligence';
import type { RipeRpkiState, RisEvent, RouteHealth, RouteVisibility } from '../api/types';

const HEALTH: Record<RouteHealth, { cls: string; label: string }> = {
  healthy: { cls: 'ok', label: 'Healthy' },
  degraded: { cls: 'warn', label: 'Degraded' },
  withdrawn: { cls: 'danger', label: 'Withdrawn' },
  critical: { cls: 'danger', label: 'Critical' },
  unknown: { cls: 'neutral', label: 'Unknown' },
};
const RPKI: Record<RipeRpkiState, { cls: string; label: string; help: string }> = {
  valid: { cls: 'ok', label: 'RPKI valid', help: 'A ROA authorises this origin for this prefix.' },
  invalid: { cls: 'danger', label: 'RPKI invalid', help: 'A ROA exists but the origin/length is not authorised — a routing-integrity condition.' },
  'not-found': { cls: 'warn', label: 'RPKI not-found', help: 'No covering ROA — the route is unprotected, which is NOT the same as invalid.' },
  'not-checked': { cls: 'neutral', label: 'RPKI —', help: 'RPKI validation did not run or was unavailable.' },
};
const SOURCE: Record<string, string> = { live: 'ok', cached: 'info', stale: 'warn', unavailable: 'danger' };
// Worst-first ordering so problems lead the table.
const HEALTH_RANK: Record<RouteHealth, number> = { critical: 0, withdrawn: 1, degraded: 2, unknown: 3, healthy: 4 };

const ago = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const pct = (r: number | null): string => (r === null ? '—' : `${r.toFixed(r < 1 ? 1 : 0)}%`);

function VisBar({ r, cls }: { r: number | null; cls: string }) {
  if (r === null) return <span className="muted">—</span>;
  return (
    <div className="ri-vis" title={`${pct(r)} RIPE RIS collector visibility`}>
      <div className={`ri-vis-fill ri-vis-${cls}`} style={{ width: `${Math.max(2, Math.min(100, r))}%` }} />
      <span className="ri-vis-label">{pct(r)}</span>
    </div>
  );
}

// Compact observed collector path: peer → … → origin, grouped, most-frequent first.
function PathChips({ p }: { p: RouteVisibility }) {
  if (p.representativePaths.length === 0) return <span className="muted">No representative path observed.</span>;
  return (
    <div className="bgi-paths">
      {p.representativePaths.slice(0, 6).map((rp, i) => (
        <div key={i} className="bgi-path" title={`${rp.collector} · ${rp.count} peer observation(s)`}>
          {rp.asPath.map((asn, j) => (
            <Fragment key={j}>
              <span className={`bgi-asn${asn === p.expectedOrigin ? ' origin' : ''}`}>AS{asn}</span>
              {j < rp.asPath.length - 1 && <span className="bgi-arrow">→</span>}
            </Fragment>
          ))}
          <span className="muted bgi-count">×{rp.count}</span>
        </div>
      ))}
    </div>
  );
}

function PrefixDetail({ p }: { p: RouteVisibility }) {
  const ripestat = `https://stat.ripe.net/${encodeURIComponent(p.prefix)}`;
  const bgptools = `https://bgp.tools/prefix/${encodeURIComponent(p.prefix)}`;
  return (
    <tr className="ri-drawer">
      <td colSpan={9}>
        <div className="bgi-detail">
          <ul className="ri-reasons">{p.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <div className="bgi-grid">
            <div><b>Expected origin</b><div>AS{p.expectedOrigin}</div></div>
            <div><b>Observed origin(s)</b><div className={p.unexpectedOrigin ? 'danger' : undefined}>{p.observedOrigins.length ? p.observedOrigins.map((o) => `AS${o}`).join(', ') : '— (none seen)'}</div></div>
            <div><b>RPKI</b><div title={RPKI[p.rpkiState].help}>{RPKI[p.rpkiState].label}{p.rpkiMaxLength != null ? ` (maxLength /${p.rpkiMaxLength})` : ''}</div></div>
            <div><b>Upstreams (before AS{p.expectedOrigin})</b><div>{p.upstreams.length ? p.upstreams.map((u) => `AS${u}`).join(', ') : '—'}</div></div>
            <div><b>RIS collector visibility</b><div>{p.collectorPeersSeen ?? '—'} of {p.collectorPeersEligible ?? '—'} peers · {p.collectorCount ?? '—'} collectors</div></div>
            <div><b>Covering aggregate</b><div>{p.coveringPrefix ?? '—'}</div></div>
            <div><b>More-specifics</b><div>{p.moreSpecifics.length ? p.moreSpecifics.join(', ') : '—'}</div></div>
            <div><b>First / last seen</b><div>{ago(p.firstSeen)} / {ago(p.lastSeen)}</div></div>
          </div>
          <div className="bgi-subhead">Observed collector paths <span className="muted">(RIPE RIS — an observed path, not the physical network)</span></div>
          <PathChips p={p} />
          <div className="bgi-subhead">CloudVision correlation</div>
          <div className="bgi-cv muted">
            <span>Local route present: <b>not yet available</b></span>
            <span>Locally originated: <b>not yet available</b></span>
            <span>Advertised to neighbours: <b>not yet available</b></span>
            <div className="bgi-cv-note">{p.cloudVision.note}</div>
          </div>
          <div className="bgi-links">
            <a href={ripestat} target="_blank" rel="noreferrer">RIPEstat ↗</a>
            <a href={bgptools} target="_blank" rel="noreferrer">bgp.tools ↗</a>
            <span className="muted">Source fetched {ago(p.sourceFetchedAt)} · freshness {p.freshness}</span>
          </div>
          {p.warnings.length > 0 && <div className="notice warn">{p.warnings.join(' · ')}</div>}
        </div>
      </td>
    </tr>
  );
}

function EventRow({ e }: { e: RisEvent }) {
  return (
    <tr className={e.kind === 'withdrawal' ? 'warn' : undefined}>
      <td><span className={`badge ${e.kind === 'withdrawal' ? 'warn' : 'info'} badge-sm`}>{e.kind}</span></td>
      <td>{e.prefix}</td>
      <td>{e.origin != null ? `AS${e.origin}` : '—'}</td>
      <td className="muted">{e.path.length ? e.path.map((a) => `AS${a}`).join(' → ') : '—'}</td>
      <td>{e.observationCount}</td>
      <td className="muted">{ago(e.lastAt)}</td>
    </tr>
  );
}

export function BgpIntelligence() {
  const t = useRipeIntelligence(20000);
  const [open, setOpen] = useState<string | null>(null);
  const snap = t.snapshot;
  const source = t.source ?? snap?.source ?? null;
  const counts = snap?.counts ?? { healthy: 0, degraded: 0, withdrawn: 0, critical: 0, unknown: 0, rpkiInvalid: 0, unexpectedOrigin: 0, total: 0 };

  const rows = useMemo(() => [...(snap?.prefixes ?? [])].sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || a.prefix.localeCompare(b.prefix)), [snap]);
  const overall = snap?.overall ?? 'unknown';
  const srcStatus = source?.status ?? 'unavailable';

  return (
    <section className="page bgi">
      <header className="page-head">
        <h1>BGP Intelligence <span className="muted">· RIPE</span></h1>
        <div className="head-meta">
          <span className={`badge ${HEALTH[overall].cls}`}>{HEALTH[overall].label}</span>
          <span className={`badge ${SOURCE[srcStatus] ?? 'neutral'}`} title="RIPE source status">RIPE source: {srcStatus}</span>
          {source?.ripestatLastSuccessAt && <span className="muted">updated {ago(source.ripestatLastSuccessAt)}</span>}
        </div>
      </header>
      <p className="muted">External route visibility as observed through RIPE RIS collectors — <b>not</b> "internet visibility". Missing RIPE data is shown as unknown, never a withdrawal.</p>

      {t.error && <div className="notice info">RIPE BGP intelligence is not connected. An Engineer can enable it (RIPE_ENABLED).</div>}
      {srcStatus === 'unavailable' && !t.error && <div className="notice danger">RIPE source is unavailable — monitoring is degraded. Existing verdicts are not current (this is NOT a route withdrawal).</div>}
      {srcStatus === 'stale' && <div className="notice warn">RIPE data is stale — treat with caution.</div>}
      {snap?.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}

      {/* Overview */}
      <div className="grid cols-4">
        <div className="card"><div className="muted">Overall route health</div><div className="stat"><span className={`badge ${HEALTH[overall].cls}`}>{HEALTH[overall].label}</span></div></div>
        <div className="card">
          <div className="muted">Monitored prefixes</div><div className="stat">{counts.total}</div>
          <div className="ri-counts">
            <span className="badge ok badge-sm">{counts.healthy} healthy</span>
            {counts.degraded > 0 && <span className="badge warn badge-sm">{counts.degraded} degraded</span>}
            {counts.withdrawn > 0 && <span className="badge danger badge-sm">{counts.withdrawn} withdrawn</span>}
            {counts.critical > 0 && <span className="badge danger badge-sm">{counts.critical} critical</span>}
            {counts.unknown > 0 && <span className="badge neutral badge-sm">{counts.unknown} unknown</span>}
          </div>
        </div>
        <div className="card"><div className="muted">Integrity flags</div><div className="stat">{counts.rpkiInvalid + counts.unexpectedOrigin}</div><div className="muted">{counts.rpkiInvalid} RPKI-invalid · {counts.unexpectedOrigin} unexpected origin</div></div>
        <div className="card">
          <div className="muted">RIPE source</div>
          <div className="stat"><span className={`badge ${SOURCE[srcStatus] ?? 'neutral'}`}>{srcStatus}</span></div>
          <div className="muted">RIPEstat {source?.ripestatReachable ? 'reachable' : 'unreachable'} · RIS Live {source?.risLiveState ?? '—'}</div>
        </div>
      </div>

      {/* Prefix table */}
      <h2>Prefixes</h2>
      <div className="matrix-wrap">
        <table className="matrix selectable">
          <thead>
            <tr><th>Prefix</th><th>AF</th><th>Expected</th><th>Observed</th><th>RPKI</th><th>RIS visibility</th><th>Covering</th><th>Health</th><th></th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="center-note">{t.loading ? 'Loading…' : 'No monitored prefixes.'}</td></tr>}
            {rows.map((p) => {
              const isOpen = open === p.prefix;
              return (
                <Fragment key={p.prefix}>
                  <tr className="row-click" onClick={() => setOpen(isOpen ? null : p.prefix)} title={p.reasons[0]}>
                    <td><b>{p.prefix}</b></td>
                    <td className="muted">{p.addressFamily === 'ipv6' ? 'v6' : 'v4'}</td>
                    <td>AS{p.expectedOrigin}</td>
                    <td className={p.unexpectedOrigin ? 'danger' : undefined}>{p.observedOrigins.length ? p.observedOrigins.map((o) => `AS${o}`).join(', ') : '—'}</td>
                    <td><span className={`badge ${RPKI[p.rpkiState].cls} badge-sm`} title={RPKI[p.rpkiState].help}>{RPKI[p.rpkiState].label}</span></td>
                    <td>{p.freshness === 'unknown' ? <span className="muted">unknown</span> : <VisBar r={p.collectorVisibilityPercent} cls={HEALTH[p.health].cls} />}</td>
                    <td className="muted">{p.coveringPrefix ?? '—'}</td>
                    <td><span className={`badge ${HEALTH[p.health].cls}`}>{HEALTH[p.health].label}</span></td>
                    <td className="muted">{isOpen ? '▾' : '▸'}</td>
                  </tr>
                  {isOpen && <PrefixDetail p={p} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* RIS Live event timeline */}
      <h2>BGP events <span className="muted">· RIS Live {source?.risLiveState === 'connected' ? '(live)' : source?.risLiveState === 'disabled' ? '(disabled)' : `(${source?.risLiveState ?? '—'})`}</span></h2>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead><tr><th>Type</th><th>Prefix</th><th>Origin</th><th>Path</th><th>Obs</th><th>Last</th></tr></thead>
          <tbody>
            {t.events.length === 0 && <tr><td colSpan={6} className="center-note">{source?.risLiveState === 'disabled' ? 'RIS Live is disabled.' : 'No BGP events observed yet.'}</td></tr>}
            {t.events.slice(0, 100).map((e) => <EventRow key={e.id} e={e} />)}
          </tbody>
        </table>
      </div>

      <p className="muted ri-foot">Read-only external observation from RIPE (RIPEstat + RIS Live). RADAR issues no BGP or router changes; CloudVision correlation (local RIB / advertised-to-neighbour) is not yet available and is never inferred from RIPE.</p>
    </section>
  );
}

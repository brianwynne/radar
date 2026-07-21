// Resolver reader — what each ISP's own recursive resolvers return for the steering record, from
// RIPE Atlas probes inside each ISP. Shows platform, the Cloudflare pool (CW/PW) split, and the
// TTLs the resolvers actually serve (does the low liveedge TTL get honoured?). A 6-hourly recurring
// baseline (instant), a "Check now" button for on-demand freshness, and a polling on/off switch to
// halt the recurring credits when not needed. Engineer-gated controls; read-only for everyone.
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { colorFor } from '../steering/platforms';
import type { ResolverCheck, ResolverIspIdentity, ResolverIdentitySnapshot, ResolverIspView, ResolverSnapshot } from '../api/types';

const ttlRange = (r: { min: number; max: number } | null): string => (r ? (r.min === r.max ? `${r.max}s` : `${r.min}–${r.max}s`) : '—');

const ago = (iso: string | null): string => {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

function IspCard({ v, target }: { v: ResolverIspView; target: string }) {
  const [open, setOpen] = useState(false);
  if (!v.covered) {
    return (
      <div className="rv-card uncovered">
        <div className="rv-head"><span className="rv-isp">{v.isp}</span><span className="rv-asn">AS{v.asn}</span></div>
        <div className="rv-nocov">{v.note ?? 'No RIPE Atlas probe coverage.'}</div>
      </div>
    );
  }
  const platforms = Object.entries(v.platforms).sort((a, b) => b[1] - a[1]);
  const pools = Object.entries(v.pools).sort((a, b) => b[1] - a[1]);
  const total = platforms.reduce((s, [, n]) => s + n, 0) || 1;
  return (
    <div className="rv-card">
      <div className="rv-head">
        <span className="rv-isp">{v.isp}</span><span className="rv-asn">AS{v.asn}</span>
        <span className="rv-count muted">{v.ispResolverCount} ISP resolvers{v.publicResolverCount > 0 ? ` · ${v.publicResolverCount} public` : ''} · {v.probeCount} probes</span>
      </div>
      <div className="rv-platforms">
        {platforms.map(([p, n]) => (
          <span key={p} className="rv-plat" style={{ borderColor: colorFor(p) }}>
            <span className="platform-dot" style={{ background: colorFor(p) }} />{p} {Math.round((n / total) * 100)}%
          </span>
        ))}
      </div>
      <div className="rv-chain" title={`The DNS resolution chain as served by ${v.isp}'s own on-net recursive resolvers`}>
        <div className="rv-chain-cap muted">Chain from {v.isp}’s on-net recursive resolvers · TTLs as served</div>
        <div className="rv-hop">
          <span className="rv-hop-name mono">{target}</span>
          <span className="rv-hop-role muted">alias</span>
          <span className="rv-hop-ttl mono">{ttlRange(v.apexTtl)}</span>
        </div>
        <div className="rv-hop-link">↓ CNAME</div>
        <div className="rv-hop rv-hop-steer" title="THE steering record — while a resolver holds this cached it won't return to NS1, so its TTL is how long NS1's steering / shed decision stays frozen.">
          <span className="rv-hop-name mono">{v.recordName ?? '*.nsone.rte.ie'}</span>
          <span className="rv-hop-role">NS1 record · steering</span>
          <span className="rv-hop-ttl mono">{ttlRange(v.recordTtl)}</span>
          {v.steeringImpeded !== null && (
            <span className={`badge badge-sm ${v.steeringImpeded ? 'warn' : 'ok'}`}>
              {v.steeringImpeded ? `frozen ~${v.steeringWindowSecs}s` : `re-steers ≤${v.steeringWindowSecs}s`}
            </span>
          )}
        </div>
        <div className="rv-hop-link">↓ CNAME</div>
        <div className="rv-hop">
          <span className="rv-hop-name mono">{v.edgeName ?? 'liveedge.rte.ie'}</span>
          <span className="rv-hop-role muted">Cloudflare LB · not steering</span>
          <span className="rv-hop-ttl mono">{ttlRange(v.edgeTtl)}</span>
          {v.honoursLowTtl !== null && <span className={`badge badge-sm ${v.honoursLowTtl ? 'ok' : 'warn'} badge-ghost`}>{v.honoursLowTtl ? 'honoured' : 'floored'}</span>}
        </div>
        {(v.vips.length > 0 || pools.length > 0) && (
          <div className="rv-hop-ips">
            <span className="rv-hop-link">↳ A</span>
            {v.vips.length
              ? v.vips.map((ip) => <span key={ip} className="rv-vip mono">{ip}</span>)
              : pools.map(([pool, n]) => <span key={pool} className="rv-vip mono">{pool}.x·{n}</span>)}
          </div>
        )}
      </div>
      {v.samples.length > 0 && (() => {
        const isp = v.samples.filter((s) => !s.public);
        const pub = v.samples.filter((s) => s.public);
        const row = (s: typeof v.samples[number], i: number) => (
          <li key={`${s.probeId}-${i}`}>
            <span className="mono rv-resolver">{s.resolver}</span>
            <span className="platform-dot" style={{ background: colorFor(s.platform ?? 'Unclassified') }} />{s.platform ?? '?'}
            <span className="muted mono">{s.target}</span>
            <span className="muted mono">rec {s.recordTtl ?? '?'}s · edge {s.edgeTtl ?? '?'}s</span>
          </li>
        );
        return (
          <>
            <button className="linklike" onClick={() => setOpen((o) => !o)}>{open ? 'hide resolvers' : `${v.samples.length} resolver answers`}</button>
            {open && (
              <>
                <ul className="rv-samples">
                  <li className="rv-group-head">On-net · {v.isp} resolvers ({isp.length})</li>
                  {isp.map(row)}
                </ul>
                {pub.length > 0 && (
                  <ul className="rv-samples rv-public-group">
                    <li className="rv-group-head">Public resolvers ({pub.length}) — not {v.isp}’s own</li>
                    {pub.map(row)}
                  </ul>
                )}
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}

// ECS is what lets NS1 steer a resolver's users by their real subnet. No ECS → NS1 sees only the
// resolver's own IP, so the ENTIRE ISP behind it gets one steering answer. Finer prefix = tighter.
function ecsVerdict(v: ResolverIspIdentity): { label: string; cls: string; detail: string } {
  if (!v.sendsEcs) return { label: 'No ECS', cls: 'warn', detail: 'whole-ISP — NS1 steers every user behind these resolvers as one' };
  const v4 = v.ecsPrefixes.filter((p) => p <= 32);
  const finest = Math.max(...v.ecsPrefixes);
  const precise = v4.length ? Math.max(...v4) >= 24 : finest >= 48;
  return {
    label: `ECS ✓ /${v.ecsPrefixes.join(', /')}`,
    cls: precise ? 'ok' : 'neutral',
    detail: precise ? 'per-subnet — NS1 can steer users individually' : 'coarse subnet — partial per-user steering',
  };
}
const isBogusResolver = (ip: string): boolean =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:|fc|fd)/i.test(ip);

function IdentityCard({ v }: { v: ResolverIspIdentity }) {
  if (!v.covered) {
    return (
      <div className="rv-card uncovered">
        <div className="rv-head"><span className="rv-isp">{v.isp}</span><span className="rv-asn">AS{v.asn}</span></div>
        <div className="rv-nocov">{v.note ?? 'No RIPE Atlas probe coverage.'}</div>
      </div>
    );
  }
  const ecs = ecsVerdict(v);
  const own = v.resolvers.filter((r) => !r.public);
  const pub = v.resolvers.filter((r) => r.public);
  const row = (r: typeof v.resolvers[number]) => (
    <li key={r.resolver} className={isBogusResolver(r.resolver) ? 'rv-idrow bogus' : 'rv-idrow'}>
      <span className="mono rv-idip">{r.resolver}</span>
      {isBogusResolver(r.resolver) && <span className="badge warn badge-sm" title="A private/loopback address as the upstream resolver usually means the probe's own forwarder answered — not a real recursive.">forwarder?</span>}
      <span className="muted rv-idprobes">{r.probeCount} probe{r.probeCount === 1 ? '' : 's'}</span>
      {r.ecs
        ? <span className="mono rv-idecs" title="EDNS Client Subnet this resolver forwards to NS1">→ {r.ecs}</span>
        : <span className="muted rv-idecs">no ECS</span>}
    </li>
  );
  return (
    <div className="rv-card">
      <div className="rv-head">
        <span className="rv-isp">{v.isp}</span><span className="rv-asn">AS{v.asn}</span>
        <span className="rv-count muted">{v.ispResolverCount} own{v.publicResolverCount > 0 ? ` · ${v.publicResolverCount} public` : ''}</span>
      </div>
      <div className="rv-ecs-head">
        <span className={`badge ${ecs.cls}`}>{ecs.label}</span>
        <span className="muted">{ecs.detail}</span>
      </div>
      <ul className="rv-idlist">
        <li className="rv-group-head">On-net · {v.isp} recursives ({own.length})</li>
        {own.length ? own.map(row) : <li className="muted rv-idrow">None seen — every probe here forwarded to a public resolver.</li>}
      </ul>
      {pub.length > 0 && (
        <ul className="rv-idlist rv-public-group">
          <li className="rv-group-head">Public resolvers via CPE ({pub.length}) — not {v.isp}’s own</li>
          {pub.map(row)}
        </ul>
      )}
    </div>
  );
}

export function ResolverView() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('connector.manage');
  const [snap, setSnap] = useState<ResolverSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'steering' | 'identity'>('steering');
  const [ident, setIdent] = useState<ResolverIdentitySnapshot | null>(null);
  const [identState, setIdentState] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    if (view !== 'identity' || ident || identState === 'loading') return;
    let live = true;
    setIdentState('loading');
    api.resolverIdentity()
      .then((s) => { if (live) { setIdent(s); setIdentState('idle'); } })
      .catch(() => { if (live) setIdentState('error'); });
    return () => { live = false; };
  }, [view, ident, identState]);

  useEffect(() => {
    let live = true;
    api.resolvers()
      .then((s) => { if (live) { setSnap(s); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load resolver data.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const covered = useMemo(() => (snap?.isps ?? []).filter((i) => i.covered).length, [snap]);

  async function checkNow() {
    setChecking(true); setCheckNote('Firing measurements from each ISP…'); setError(null);
    try {
      const { checks } = await api.resolverCheck();
      const start = Date.now();
      // Poll until every covered ISP has reported, or ~3 min.
      for (;;) {
        await new Promise((r) => setTimeout(r, 12000));
        const { snapshot, pending } = await api.resolverCheckResults(checks as ResolverCheck[]);
        setSnap(snapshot);
        if (!pending) { setCheckNote(`Fresh check complete — ${covered} ISPs.`); break; }
        if (Date.now() - start > 180000) { setCheckNote('Still measuring — showing what has reported so far.'); break; }
        setCheckNote('Waiting for probes to report…');
      }
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Check failed.');
    } finally {
      setChecking(false);
    }
  }

  async function togglePolling() {
    if (!snap) return;
    setBusy(true);
    try {
      const { pollingEnabled } = await api.resolverPolling(!snap.pollingEnabled);
      setSnap({ ...snap, pollingEnabled });
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not change polling.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <span className="muted">Loading resolver data…</span>;
  if (error && !snap) return <div className="notice danger">{error}</div>;
  if (!snap) return <div className="notice info">No resolver data.</div>;

  const mode = snap.provenance.source;
  return (
    <div className="rv">
      <div className="rv-bar">
        <div className="rv-bar-l">
          <span className={`badge ${mode === 'ripe-atlas' ? 'ok' : mode === 'mock' ? 'warn' : 'neutral'}`}>
            {mode === 'ripe-atlas' ? 'LIVE · RIPE Atlas' : mode === 'mock' ? 'MOCK · SYNTHETIC' : 'DISABLED'}
          </span>
          <div className="rv-viewtoggle" role="tablist">
            <button role="tab" aria-selected={view === 'steering'} className={view === 'steering' ? 'on' : ''} onClick={() => setView('steering')}>Steering</button>
            <button role="tab" aria-selected={view === 'identity'} className={view === 'identity' ? 'on' : ''} onClick={() => setView('identity')}>Resolver identity</button>
          </div>
          <span className="muted">
            {view === 'steering'
              ? <>What each ISP’s resolvers return for <b className="mono">{snap.target}</b> · baseline {ago(snap.observedAt)}</>
              : <>The ISP’s <b>real recursive resolvers</b> + how precisely NS1 can steer them{ident ? ` · ${ago(ident.observedAt)}` : ''}</>}
          </span>
        </div>
        <div className="rv-bar-r">
          {canManage && (
            <label className="switch" title="Turn the 6-hourly recurring measurements on/off to control RIPE Atlas credit spend">
              <input type="checkbox" checked={snap.pollingEnabled ?? true} disabled={busy} onChange={togglePolling} /> 6h polling
            </label>
          )}
          {canManage && <button className="primary" onClick={checkNow} disabled={checking}>{checking ? 'Checking…' : 'Check resolvers now'}</button>}
        </div>
      </div>
      {checkNote && <div className="notice info rv-note">{checking && <span className="rv-spin" />}{checkNote}</div>}
      {error && <div className="notice danger">{error}</div>}

      {view === 'steering' ? (
        <>
          <div className="notice info rv-explain">
            <span className="mono">live.rte.ie</span> is only a user-facing alias — <b>steering happens at the NS1 record</b> (<span className="mono">*.nsone.rte.ie</span>). The <b>steering TTL</b> below is that record’s TTL: while a resolver holds it cached it won’t return to NS1, so it’s how long NS1’s steering / shed decision stays <b>frozen</b> for the ISP. A high value <b>impedes steering</b>. The <b>edge TTL</b> is a separate layer (Cloudflare LB pool refresh) and does not affect NS1 steering.
          </div>
          {snap.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}
          {snap.isps.length === 0 ? (
            <div className="notice info">{snap.provenance.notice ?? 'No resolver data — the RIPE Atlas connector is not connected.'}{canManage && ' Turn on 6h polling or run a check to populate it.'}</div>
          ) : (
            <div className="rv-grid">
              {snap.isps.map((v) => <IspCard key={v.isp} v={v} target={snap.target} />)}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="notice info rv-explain">
            These are each ISP’s <b>actual recursive resolvers</b> — the shared caches the whole ISP sits behind, revealed via <span className="mono">whoami.ds.akahelp.net</span> (the only query that survives the CPE→recursive→probe path; <span className="mono">live.rte.ie</span> arrives with the upstream already stripped).
            The <span className="mono">192.168.x</span>/loopback addresses in <b>Steering</b> are home-router forwarders <i>in front of</i> these; their TTLs only matter where they cache longer than the recursive above. NS1 steers by the <b>ECS</b> each recursive sends — no ECS means the whole ISP gets one answer. ECS shown is the resolver’s general policy (a good proxy for what NS1 sees).
          </div>
          {identState === 'loading' && <span className="muted">Loading resolver identity…</span>}
          {identState === 'error' && <div className="notice danger">Could not load resolver identity.</div>}
          {ident && (ident.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>))}
          {ident && (ident.isps.length === 0 ? (
            <div className="notice info">{ident.provenance.notice ?? 'No resolver-identity data — the RIPE Atlas connector is not connected.'}</div>
          ) : (
            <div className="rv-grid">
              {ident.isps.map((v) => <IdentityCard key={v.isp} v={v} />)}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
